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
    time::Duration,
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
            }),
            server: Mutex::new(None),
        })
    }
    pub fn status(&self) -> Result<Status> {
        let mut s = self.status.lock().unwrap().clone();
        s.busy = self.busy.load(Ordering::Relaxed);
        s.model_ready = inference::model_ready(&inference::model_directory(&self.db.root));
        s.automatic = self.db.setting("automatic", "false")? == "true";
        Ok(s)
    }
    fn update(&self, phase: &str, message: String) {
        let mut s = self.status.lock().unwrap();
        s.phase = phase.into();
        s.message = message;
        s.revision += 1;
    }
    pub fn start(self: &Arc<Self>, action: &str) -> Result<()> {
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
                let _ = me.db.set_setting("automatic", "false");
            } else if me.cancel.load(Ordering::Relaxed) {
                me.update("idle", "Paused. Unfinished images stay queued.".into());
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
        if action == "scan" {
            return Ok(());
        }
        if self.db.next()?.is_none() {
            return Ok(());
        }
        if !inference::model_ready(&models) {
            anyhow::bail!("Download the Qwen model to classify your indexed images")
        }
        let server = {
            let mut slot = self.server.lock().unwrap();
            if slot.is_none() {
                self.update("loading", "Loading Qwen on 8 CPU threads…".into());
                *slot = Some(Arc::new(Server::start(
                    &self.runtime,
                    &models,
                    &self.db.root.join("llama-server.log"),
                    &self.cancel,
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
            let result = server.classify(std::path::Path::new(&photo.path), &folder);
            if self.closing.load(Ordering::Relaxed) {
                return Ok(());
            }
            match result {
                Ok(result) => {
                    self.db.store(photo.id, result, Some(photo.modified))?;
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
    pub fn pause(&self) -> Result<()> {
        self.db.set_setting("automatic", "false")?;
        self.cancel.store(true, Ordering::Relaxed);
        Ok(())
    }
    pub fn automatic(self: &Arc<Self>, enabled: bool) -> Result<()> {
        self.db
            .set_setting("automatic", if enabled { "true" } else { "false" })?;
        if !enabled {
            self.cancel.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn monitor(self: &Arc<Self>) {
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let mut ticks = 0;
            while !me.closing.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_secs(1));
                ticks += 1;
                if ticks >= 30 {
                    ticks = 0;
                    if !me.busy.load(Ordering::Relaxed)
                        && me
                            .db
                            .setting("automatic", "false")
                            .is_ok_and(|s| s == "true")
                    {
                        let _ = me.start("classify");
                    }
                }
            }
        });
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Relaxed);
        self.cancel.store(true, Ordering::Relaxed);
        if let Some(server) = self.server.lock().unwrap().take() {
            server.stop();
        }
    }
}
