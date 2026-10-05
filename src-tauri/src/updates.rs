//! Download while the library is open; activate verified packages only on a subsequent launch.
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    phase: String,
    version: String,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
}
pub struct Updates(Mutex<UpdateStatus>);
#[derive(Debug, Serialize, Deserialize)]
struct Pending {
    version: String,
    signature: String,
}
fn directory(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("updates"))
}
fn supported() -> bool {
    cfg!(windows) || (cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some())
}
fn set(app: &AppHandle, status: UpdateStatus) {
    *app.state::<Updates>().0.lock().unwrap() = status;
}
fn fail(app: &AppHandle, error: impl std::fmt::Display) {
    set(
        app,
        UpdateStatus {
            phase: "error".into(),
            error: Some(error.to_string()),
            ..Default::default()
        },
    );
}
fn verify(bytes: &[u8], signature: &str, version: &str) -> Result<()> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .context("Missing update public key")?;
    verify_with_key(bytes, signature, version, key)
}
fn verify_with_key(bytes: &[u8], signature: &str, version: &str, key: &str) -> Result<()> {
    let key = String::from_utf8(STANDARD.decode(key)?)?;
    let signature = String::from_utf8(STANDARD.decode(signature)?)?;
    let signature = minisign_verify::Signature::decode(&signature)?;
    minisign_verify::PublicKey::decode(&key)?.verify(bytes, &signature, true)?;
    let comment = signature.trusted_comment();
    let signed = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .context("Signature is missing the app version")?;
    if semver::Version::parse(signed)? != semver::Version::parse(version)? {
        bail!("Signed update version does not match");
    }
    Ok(())
}
fn pending(dir: &Path, current: &str) -> Result<Option<(Pending, Vec<u8>)>> {
    if !dir.join("pending.json").exists() {
        return Ok(None);
    }
    let metadata: Pending = serde_json::from_slice(&fs::read(dir.join("pending.json"))?)?;
    if semver::Version::parse(&metadata.version)? <= semver::Version::parse(current)? {
        fs::remove_file(dir.join("pending.json"))?;
        let _ = fs::remove_file(dir.join("package"));
        let _ = fs::remove_file(dir.join("attempted"));
        let _ = fs::remove_file(dir.join("installer.exe"));
        return Ok(None);
    }
    if dir.join("attempted").exists() {
        bail!("The previous update did not finish. Download it again to retry.");
    }
    let bytes = fs::read(dir.join("package"))?;
    verify(&bytes, &metadata.signature, &metadata.version)
        .context("The staged update failed signature verification")?;
    Ok(Some((metadata, bytes)))
}
fn activate(app: &AppHandle) -> Result<()> {
    let dir = directory(app)?;
    let Some((_, bytes)) = pending(&dir, &app.package_info().version.to_string())? else {
        return Ok(());
    };
    if !supported() {
        bail!("Install the AppImage to enable automatic updates on Linux.");
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let target =
            PathBuf::from(std::env::var_os("APPIMAGE").context("Not running an AppImage")?);
        let replacement = target.with_extension("AppImage.update");
        fs::write(&replacement, &bytes)?;
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o755))?;
        fs::File::open(&replacement)?.sync_all()?;
        fs::rename(&replacement, &target).context("Cannot replace the installed AppImage")?;
        fs::write(dir.join("attempted"), b"1")?;
        app.restart();
    }
    #[cfg(windows)]
    {
        let installer = dir.join("installer.exe");
        fs::write(&installer, &bytes)?;
        fs::write(dir.join("attempted"), b"1")?;
        if let Err(error) = std::process::Command::new(installer)
            .args(["/S", "/UPDATE", "/R"])
            .spawn()
        {
            let _ = fs::remove_file(dir.join("attempted"));
            return Err(error.into());
        }
        std::process::exit(0);
    }
    #[allow(unreachable_code)]
    Ok(())
}
pub fn initialize(app: &AppHandle) {
    app.manage(Updates(Mutex::new(UpdateStatus {
        phase: if supported() { "idle" } else { "unsupported" }.into(),
        ..Default::default()
    })));
    if let Err(error) = activate(app) {
        fail(app, error);
        return;
    }
    if supported() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = check_update(app).await;
        });
    }
}
#[tauri::command]
pub fn update_status(state: State<Updates>) -> UpdateStatus {
    state.0.lock().unwrap().clone()
}
fn begin(app: &AppHandle, phase: &str) -> Result<()> {
    let state = app.state::<Updates>();
    let mut status = state.0.lock().unwrap();
    if matches!(status.phase.as_str(), "checking" | "downloading" | "ready") {
        bail!("An update is already in progress");
    }
    if !supported() {
        bail!("Install the AppImage to enable automatic updates on Linux.");
    }
    *status = UpdateStatus {
        phase: phase.into(),
        ..Default::default()
    };
    Ok(())
}
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<(), String> {
    begin(&app, "checking").map_err(|e| e.to_string())?;
    let result = async {
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()?
            .check()
            .await?;
        set(
            &app,
            UpdateStatus {
                phase: if update.is_some() {
                    "available"
                } else {
                    "current"
                }
                .into(),
                version: update.map(|u| u.version).unwrap_or_default(),
                ..Default::default()
            },
        );
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = result {
        fail(&app, &error);
        return Err(error.to_string());
    }
    Ok(())
}
#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    begin(&app, "downloading").map_err(|e| e.to_string())?;
    let result = async {
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(1800))
            .build()?
            .check()
            .await?
            .context("No update is available")?;
        let bytes = update
            .download(
                |length, total| {
                    let state = app.state::<Updates>();
                    let mut status = state.0.lock().unwrap();
                    status.downloaded += length as u64;
                    status.total = total;
                },
                || {},
            )
            .await?;
        let dir = directory(&app)?;
        fs::create_dir_all(&dir)?;
        // Remove the commit marker first: an interrupted download must never be activated.
        let _ = fs::remove_file(dir.join("pending.json"));
        fs::write(dir.join("package"), &bytes)?;
        fs::File::open(dir.join("package"))?.sync_all()?;
        let _ = fs::remove_file(dir.join("attempted"));
        fs::write(
            dir.join("pending.tmp"),
            serde_json::to_vec(&Pending {
                version: update.version.clone(),
                signature: update.signature,
            })?,
        )?;
        fs::rename(dir.join("pending.tmp"), dir.join("pending.json"))?;
        set(
            &app,
            UpdateStatus {
                phase: "ready".into(),
                version: update.version,
                ..Default::default()
            },
        );
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = result {
        fail(&app, &error);
        return Err(error.to_string());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_payload_and_version() {
        let bytes = include_bytes!("../tests/fixtures/update.txt");
        let signature = include_str!("../tests/fixtures/update.txt.sig").trim();
        let key = include_str!("../tests/fixtures/update.pub").trim();
        assert!(verify_with_key(bytes, signature, "0.2.0", key).is_ok());
        assert!(verify_with_key(b"tampered", signature, "0.2.0", key).is_err());
        assert!(verify_with_key(bytes, signature, "0.3.0", key).is_err());
    }
    #[test]
    fn refuses_to_repeat_failed_activation() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("pending.json"),
            r#"{"version":"9.0.0","signature":"unused"}"#,
        )
        .unwrap();
        fs::write(dir.path().join("attempted"), b"1").unwrap();
        assert!(pending(dir.path(), "0.1.0")
            .unwrap_err()
            .to_string()
            .contains("previous update"));
    }
    #[test]
    fn rejects_unsigned_pending_package() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("package"), b"untrusted executable").unwrap();
        fs::write(
            dir.path().join("pending.json"),
            r#"{"version":"9.0.0","signature":"invalid"}"#,
        )
        .unwrap();
        assert!(pending(dir.path(), "0.1.0").is_err());
    }
    #[test]
    fn completed_update_is_cleaned_up() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("pending.json"),
            r#"{"version":"0.1.0","signature":"unused"}"#,
        )
        .unwrap();
        assert!(pending(dir.path(), "0.1.0").unwrap().is_none());
        assert!(!dir.path().join("pending.json").exists());
    }
}
