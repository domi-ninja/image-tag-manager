use crate::db::{Classification, Folder};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageDecoder, ImageReader};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub const MODEL: &str = "Qwen3VL-2B-Instruct-Q8_0.gguf";
pub const PROJECTOR: &str = "mmproj-Qwen3VL-2B-Instruct-F16.gguf";
const REVISION: &str = "52d6c8ffea26cc873ac5ad116f8631268d7eb503";
const FILES: [(&str, u64, &str); 2] = [
    (
        MODEL,
        1834427424,
        "1e8db19207c8ce0733ddd78c2eff8a9e22c27c82f4443df94c25792ed8fe04f2",
    ),
    (
        PROJECTOR,
        819394848,
        "c3d5afbef5287953acd57b4043d2269456e5761a4eaccb3b71b062996970aea5",
    ),
];
pub fn model_ready(root: &Path) -> bool {
    FILES.iter().all(|(name, size, hash)| {
        fs::metadata(root.join(name)).is_ok_and(|m| m.len() == *size)
            && fs::read_to_string(root.join(format!("{name}.verified"))).is_ok_and(|s| s == *hash)
    })
}

/// Downloads only official, pinned model files. Interrupted downloads resume next time.
pub fn download(root: &Path, cancel: &AtomicBool, progress: impl Fn(String)) -> Result<()> {
    fs::create_dir_all(root)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(7200))
        .build()?;
    for (name, size, hash) in FILES {
        let target = root.join(name);
        let marker = root.join(format!("{name}.verified"));
        if fs::metadata(&target).is_ok_and(|m| m.len() == size)
            && fs::read_to_string(&marker).is_ok_and(|s| s == hash)
        {
            continue;
        }
        let partial = root.join(format!("{name}.part"));
        let existing = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
        let url = format!(
            "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/{REVISION}/{name}"
        );
        let mut request = client.get(url);
        if existing > 0 && existing < size {
            request = request.header("Range", format!("bytes={existing}-"));
        }
        if existing != size {
            let mut response = request.send()?.error_for_status()?;
            let append = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&partial)?;
            let mut received = if append { existing } else { 0 };
            let mut buffer = vec![0u8; 131072];
            let mut last = Instant::now() - Duration::from_secs(1);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    bail!("Download paused. Choose Download model to resume.")
                }
                let n = response.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                file.write_all(&buffer[..n])?;
                received += n as u64;
                if last.elapsed() > Duration::from_millis(500) {
                    progress(format!("Downloading {name}: {}%", received * 100 / size));
                    last = Instant::now();
                }
            }
            file.sync_all()?;
        }
        progress(format!("Verifying {name}…"));
        let mut file = File::open(&partial)?;
        let mut digest = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("Download paused")
            };
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            digest.update(&buf[..n]);
        }
        if format!("{:x}", digest.finalize()) != hash {
            fs::remove_file(&partial)?;
            bail!("Model checksum mismatch. Retry the download.")
        }
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&partial, &target)?;
        fs::write(marker, hash)?;
    }
    Ok(())
}

static IMAGE_DECODE: Mutex<()> = Mutex::new(());
pub fn jpeg(path: &Path, max: u32) -> Result<Vec<u8>> {
    let _permit = IMAGE_DECODE
        .lock()
        .map_err(|_| anyhow::anyhow!("Image decoder unavailable"))?;
    let image = decode_image(path)?;
    let image = image.thumbnail(max, max).to_rgb8();
    let mut bytes = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 88).encode_image(&image)?;
    Ok(bytes.into_inner())
}

#[cfg(feature = "desktop")]
pub fn rgba(path: &Path) -> Result<image::RgbaImage> {
    let _permit = IMAGE_DECODE
        .lock()
        .map_err(|_| anyhow::anyhow!("Image decoder unavailable"))?;
    Ok(decode_image(path)?.to_rgba8())
}

fn decode_image(path: &Path) -> Result<image::DynamicImage> {
    if fs::metadata(path)?.len() > 100 * 1024 * 1024 {
        bail!("Image exceeds the 100 MB limit")
    }
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}
pub fn data_url(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))
}

pub struct Server {
    child: Mutex<Child>,
    _parent_lifetime: crate::process::ParentGuard,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
    client: Client,
    url: String,
    key: String,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Server {
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub fn start(
        runtime: &Path,
        models: &Path,
        log: &Path,
        cancel: &AtomicBool,
        threads: usize,
    ) -> Result<Self> {
        if !model_ready(models) {
            bail!("Download the Qwen model first")
        }
        let executable = runtime.join(if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        });
        if !executable.is_file() {
            bail!("The bundled llama.cpp runtime is missing. Run pnpm prepare:runtime before building.")
        }
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let key = uuid::Uuid::new_v4().to_string();
        let mut cmd = Command::new(executable);
        cmd.args(["--model"])
            .arg(models.join(MODEL))
            .arg("--mmproj")
            .arg(models.join(PROJECTOR))
            .arg("--threads")
            .arg(threads.to_string())
            .arg("--threads-batch")
            .arg(threads.to_string())
            .args([
                "--n-gpu-layers",
                "0",
                "--no-mmproj-offload",
                "--ctx-size",
                "4096",
                "--parallel",
                "1",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--jinja",
                "--no-webui",
                "--api-key",
                &key,
            ])
            .stdin(Stdio::null())
            .stdout(File::create(log)?)
            .stderr(File::options().append(true).open(log)?);
        let client = Client::builder()
            .timeout(Duration::from_secs(300))
            .no_proxy()
            .build()?;
        let (child, parent_lifetime) =
            crate::process::spawn(cmd).context("Could not start the bundled llama.cpp runtime")?;
        #[cfg(windows)]
        let job = match crate::process::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        };
        let server = Self {
            child: Mutex::new(child),
            _parent_lifetime: parent_lifetime,
            #[cfg(windows)]
            _job: job,
            client,
            url: format!("http://127.0.0.1:{port}"),
            key,
        };
        let started = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("Loading cancelled")
            }
            if let Some(status) = server.child.lock().unwrap().try_wait()? {
                bail!("llama.cpp exited ({status}). See {}", log.display())
            }
            if server
                .client
                .get(format!("{}/health", server.url))
                .bearer_auth(&server.key)
                .timeout(Duration::from_millis(500))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                return Ok(server);
            }
            if started.elapsed() > Duration::from_secs(180) {
                bail!("Timed out loading Qwen. See {}", log.display())
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    pub fn classify(&self, path: &Path, folder: &Folder) -> Result<Classification> {
        let image = data_url(&jpeg(path, 1024)?);
        let mut schema = json!({"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"},"minItems":5,"maxItems":8},"caption":{"type":"string"},"category":{"type":"null"}},"required":["tags","caption","category"],"additionalProperties":false});
        if !folder.categories.is_empty() {
            let mut options: Vec<Value> = folder.categories.iter().map(|s| json!(s)).collect();
            options.push(Value::Null);
            schema["properties"]["category"] = json!({"enum":options});
        }
        let prompt=format!("Identify the main visible subjects and scene. Return JSON with 5 to 8 short descriptive tags, one concise caption, and a category. Describe only visibly supported details. Avoid guessing time of day, exact species, place, brands, identities or setting. Choose a category only from this list, or null when none fits: {}. Additional user instructions: {}",serde_json::to_string(&folder.categories)?,folder.instructions);
        let response:Value=self.client.post(format!("{}/v1/chat/completions",self.url)).bearer_auth(&self.key)
            .json(&json!({"messages":[{"role":"user","content":[{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":image}}]}],"temperature":0,"max_tokens":320,"response_format":{"type":"json_schema","json_schema":{"name":"classification","strict":true,"schema":schema}}})).send()?.error_for_status()?.json()?;
        if response["choices"][0]["finish_reason"] == "length" {
            bail!("Model output was truncated; retry this image")
        }
        let content = response["choices"][0]["message"]["content"]
            .as_str()
            .context("Model returned no content")?;
        let result: Classification =
            serde_json::from_str(content).context("Model returned invalid classification JSON")?;
        if result.caption.trim().is_empty() || result.tags.is_empty() {
            bail!("Model returned an empty classification")
        }
        if let Some(category) = &result.category {
            if !folder.categories.contains(category) {
                bail!("Model returned an unknown category")
            }
        }
        Ok(result)
    }
}

pub fn thumbnail(db: &crate::db::Db, id: i64) -> Result<String> {
    let photo = db.photo(id)?;
    let path = db
        .root
        .join("thumbnails")
        .join(format!("{id}-{}.jpg", photo.modified));
    let bytes = if path.exists() {
        fs::read(path)?
    } else {
        let bytes = jpeg(Path::new(&photo.path), 360)?;
        fs::write(path, &bytes)?;
        bytes
    };
    Ok(data_url(&bytes))
}
pub fn model_directory(root: &Path) -> PathBuf {
    root.join("models")
}
