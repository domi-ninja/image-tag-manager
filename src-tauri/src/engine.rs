use crate::{
    db::Db,
    inference::{self, Server},
};
use anyhow::Result;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub busy: bool,
    pub phase: String,
    pub message: String,
    pub processed: u64,
    pub model_ready: bool,
    pub automatic: bool,
    pub revision: u64,
    pub cpu_threads: usize,
    pub max_cpu_threads: usize,
}
pub struct Engine {
    pub db: Db,
    pub runtime: PathBuf,
    pub cancel: AtomicBool,
    pub closing: AtomicBool,
    busy: AtomicBool,
    status: Mutex<Status>,
    server: Mutex<Option<Arc<Server>>>,
}
impl Engine {
    pub fn new(db: Db, runtime: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            db,
            runtime,
            cancel: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            status: Mutex::new(Status {
                busy: false,
                phase: "idle".into(),
                message: "Ready".into(),
                processed: 0,
                model_ready: false,
                automatic: false,
                revision: 0,
                cpu_threads: 0,
                max_cpu_threads: 0,
            }),
            server: Mutex::new(None),
        })
    }
    pub fn status(&self) -> Result<Status> {
        let mut s = self.status.lock().unwrap().clone();
        s.busy = self.busy.load(Ordering::Relaxed);
        s.model_ready = inference::model_ready(&inference::model_directory(&self.db.root));
        s.automatic = self.db.setting("automatic", "false")? == "true";
        s.cpu_threads = self.cpu_threads()?;
        s.max_cpu_threads = max_cpu_threads();
        Ok(s)
    }
    fn cpu_threads(&self) -> Result<usize> {
        let max = max_cpu_threads();
        Ok(self
            .db
            .setting("cpu_threads", "8")?
            .parse::<usize>()
            .ok()
            .filter(|threads| (1..=max).contains(threads))
            .unwrap_or(8.min(max)))
    }
    pub fn set_cpu_threads(&self, threads: usize) -> Result<()> {
        if !(1..=max_cpu_threads()).contains(&threads) {
            anyhow::bail!("Choose a CPU thread count supported by this computer")
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            anyhow::bail!("Wait for the current task before changing CPU threads")
        }
        let result = self.db.set_setting("cpu_threads", &threads.to_string());
        if result.is_ok() {
            self.server.lock().unwrap().take();
        }
        self.busy.store(false, Ordering::SeqCst);
        result
    }
    fn update(&self, phase: &str, message: String) {
        let mut s = self.status.lock().unwrap();
        s.phase = phase.into();
        s.message = message;
        s.revision += 1;
    }
    pub fn start(self: &Arc<Self>, action: &str) -> Result<()> {
        if self.closing.load(Ordering::Relaxed) {
            anyhow::bail!("Application is closing")
        }
        if !["scan", "classify", "download"].contains(&action) {
            anyhow::bail!("Unknown action")
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            anyhow::bail!("A task is already running")
        }
        self.cancel.store(false, Ordering::Relaxed);
        let me = Arc::clone(self);
        let action = action.to_string();
        self.update(&action, format!("Starting {action}…"));
        self.status.lock().unwrap().processed = 0;
        std::thread::spawn(move || {
            let result = me.work(&action);
            if let Err(e) = result {
                me.update("error", format!("{e:#}"));
                if action == "classify" {
                    let _ = me.db.set_setting("automatic", "false");
                }
            } else if me.cancel.load(Ordering::Relaxed) {
                me.update("idle", "Paused".into());
            } else {
                me.update("idle", "Up to date".into());
            }
            me.busy.store(false, Ordering::SeqCst);
        });
        Ok(())
    }
    fn work(&self, action: &str) -> Result<()> {
        let models = inference::model_directory(&self.db.root);
        if action == "download" {
            return inference::download(&models, &self.cancel, |message| {
                self.update("download", message)
            });
        }
        if action == "scan" {
            return self.scan_folders();
        }
        if self.db.next()?.is_none() {
            return Ok(());
        }
        if !inference::model_ready(&models) {
            anyhow::bail!("Download the Qwen model to classify your indexed images")
        }
        let threads = self.cpu_threads()?;
        let server = {
            let mut slot = self.server.lock().unwrap();
            if slot.is_none() {
                self.update("loading", format!("Loading Qwen on {threads} CPU threads…"));
                *slot = Some(Arc::new(Server::start(
                    &self.runtime,
                    &models,
                    &self.db.root.join("llama-server.log"),
                    &self.cancel,
                    threads,
                )?));
            }
            Arc::clone(slot.as_ref().unwrap())
        };
        let mut consecutive_failures = 0;
        while !self.cancel.load(Ordering::Relaxed) {
            let Some(photo) = self.db.next()? else { break };
            let Some(folder) = self
                .db
                .folders()?
                .into_iter()
                .find(|f| f.id == photo.folder_id && f.enabled)
            else {
                continue;
            };
            self.update("classify", format!("Classifying {}", photo.filename));
            let started = Instant::now();
            let result = server.classify(std::path::Path::new(&photo.path), &folder);
            let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            if self.closing.load(Ordering::Relaxed) {
                return Ok(());
            }
            match result {
                Ok(result) => {
                    if self.db.store(photo.id, result, Some(photo.modified))? {
                        self.db
                            .record_classification_timing(photo.id, threads, elapsed_ms)?;
                    }
                    consecutive_failures = 0;
                }
                Err(e) => {
                    self.db.fail(photo.id, &format!("{e:#}"))?;
                    consecutive_failures += 1;
                    if consecutive_failures >= 3 {
                        self.server.lock().unwrap().take();
                        anyhow::bail!("Stopped after three failed images. Last error: {e:#}. Review failed images and retry.");
                    }
                }
            }
            let mut status = self.status.lock().unwrap();
            status.processed += 1;
            status.revision += 1;
        }
        Ok(())
    }
    fn scan_folders(&self) -> Result<()> {
        let mut scan_errors = Vec::new();
        for folder in self.db.folders()?.into_iter().filter(|f| f.enabled) {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            self.update("scan", format!("Scanning {}…", folder.name));
            if let Err(e) = self.db.scan(&folder, &self.cancel) {
                scan_errors.push(format!("{}: {e:#}", folder.name));
            }
        }
        if !scan_errors.is_empty() {
            anyhow::bail!("{}", scan_errors.join("; "))
        }
        Ok(())
    }

    pub fn pause(&self) -> Result<()> {
        self.db.set_setting("automatic", "false")?;
        self.cancel.store(true, Ordering::Relaxed);
        Ok(())
    }
    pub fn automatic(self: &Arc<Self>, enabled: bool) -> Result<()> {
        self.db
            .set_setting("automatic", if enabled { "true" } else { "false" })?;
        if !enabled
            && matches!(
                self.status.lock().unwrap().phase.as_str(),
                "classify" | "loading"
            )
        {
            self.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn monitor(self: &Arc<Self>) {
        self.monitor_with_intervals(Duration::from_secs(60 * 60), Duration::from_secs(1));
    }
    fn monitor_with_intervals(
        self: &Arc<Self>,
        scan_interval: Duration,
        poll_interval: Duration,
    ) -> std::thread::JoinHandle<()> {
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let mut next_scan = Instant::now();
            let mut next_classify = Instant::now();
            while !me.closing.load(Ordering::Relaxed) {
                let now = Instant::now();
                if !me.busy.load(Ordering::Relaxed) {
                    // An overdue scan stays due while another task is running.
                    if now >= next_scan {
                        if me.start("scan").is_ok() {
                            next_scan = now + scan_interval;
                        }
                    } else if now >= next_classify {
                        next_classify = now + Duration::from_secs(30);
                        if me
                            .db
                            .setting("automatic", "false")
                            .is_ok_and(|s| s == "true")
                            && me.db.next().is_ok_and(|photo| photo.is_some())
                        {
                            let _ = me.start("classify");
                        }
                    }
                }
                std::thread::sleep(poll_interval);
            }
        })
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Relaxed);
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(server) = self.server.lock().unwrap().take() {
            server.stop();
        }
    }
}
fn max_cpu_threads() -> usize {
    std::thread::available_parallelism().map_or(8, |count| count.get())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !predicate() {
            assert!(Instant::now() < deadline, "Timed out waiting for worker");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn startup_and_periodic_scans_run_without_auto_classification_and_wait_for_busy_worker() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("photos");
        std::fs::create_dir(&images).unwrap();
        std::fs::write(images.join("one.jpg"), b"image").unwrap();
        let db = Db::new(dir.path().join("db")).unwrap();
        db.add_folder(images.to_str().unwrap()).unwrap();
        let engine = Engine::new(db, dir.path().join("no-runtime"));
        // Hold the worker before the monitor starts, so the first scan is definitely due.
        engine.busy.store(true, Ordering::SeqCst);
        let monitor =
            engine.monitor_with_intervals(Duration::from_millis(80), Duration::from_millis(5));
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(engine.db.stats().unwrap().total, 0);
        engine.busy.store(false, Ordering::SeqCst);
        wait_until(|| engine.db.stats().unwrap().total == 1 && !engine.busy.load(Ordering::SeqCst));
        assert!(!engine.status().unwrap().automatic);
        assert_eq!(engine.db.stats().unwrap().pending, 1);
        assert!(engine.server.lock().unwrap().is_none());
        std::fs::write(images.join("two.jpg"), b"image").unwrap();
        wait_until(|| engine.db.stats().unwrap().total == 2 && !engine.busy.load(Ordering::SeqCst));
        engine.shutdown();
        monitor.join().unwrap();
        assert!(engine.start("scan").is_err());
    }

    #[test]
    fn classification_does_not_rescan_and_scan_errors_do_not_disable_auto_classification() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("photos");
        std::fs::create_dir(&images).unwrap();
        std::fs::write(images.join("one.jpg"), b"image").unwrap();
        let db = Db::new(dir.path().join("db")).unwrap();
        db.add_folder(images.to_str().unwrap()).unwrap();
        let engine = Engine::new(db, dir.path().join("no-runtime"));
        engine.work("classify").unwrap();
        assert_eq!(engine.db.stats().unwrap().total, 0);
        engine.db.set_setting("automatic", "true").unwrap();
        std::fs::remove_dir_all(images).unwrap();
        engine.start("scan").unwrap();
        wait_until(|| !engine.busy.load(Ordering::SeqCst));
        assert_eq!(engine.status().unwrap().phase, "error");
        assert!(engine.status().unwrap().automatic);
    }
    #[test]
    fn cpu_thread_setting_is_validated_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::new(dir.path().join("db")).unwrap();
        let engine = Engine::new(db, dir.path().join("runtime"));
        assert!(engine.set_cpu_threads(0).is_err());
        assert!(engine.set_cpu_threads(max_cpu_threads() + 1).is_err());
        engine.set_cpu_threads(1).unwrap();
        assert_eq!(engine.status().unwrap().cpu_threads, 1);
        let reopened = Engine::new(engine.db.clone(), dir.path().join("runtime"));
        assert_eq!(reopened.status().unwrap().cpu_threads, 1);
        engine.busy.store(true, Ordering::SeqCst);
        assert!(engine.set_cpu_threads(1).is_err());
        assert_eq!(engine.status().unwrap().cpu_threads, 1);
    }
}
