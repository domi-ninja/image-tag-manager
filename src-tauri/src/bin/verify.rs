//! Exercise the same database, model download, and native inference used by the desktop.
use anyhow::{Context, Result};
use image_tag_manager::{
    db::{Db, Search},
    inference::{self, Server},
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(
        args.get(1)
            .context("Usage: verify DATA_DIR IMAGE_DIR RUNTIME_DIR [LIMIT]")?,
    );
    let images = args.get(2).context("Missing image folder")?;
    let runtime = Path::new(args.get(3).context("Missing runtime directory")?);
    let limit = args
        .get(4)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(3);
    let db = Db::new(&root)?;
    if db.folders()?.is_empty() {
        db.add_folder(images)?;
    }
    let cancel = AtomicBool::new(false);
    for folder in db.folders()? {
        println!(
            "Indexed {} files in {}",
            db.scan(&folder, &cancel)?,
            folder.name
        );
    }
    let models = inference::model_directory(&root);
    inference::download(&models, &cancel, |s| println!("{s}"))?;
    let server = Server::start(runtime, &models, &root.join("llama-server.log"), &cancel)?;
    for _ in 0..limit {
        let Some(photo) = db.next()? else { break };
        let folder = db
            .folders()?
            .into_iter()
            .find(|f| f.id == photo.folder_id)
            .unwrap();
        let started = Instant::now();
        let result = server.classify(Path::new(&photo.path), &folder)?;
        println!(
            "{} ({:.1}s): {}",
            photo.filename,
            started.elapsed().as_secs_f64(),
            serde_json::to_string(&result)?
        );
        db.store(photo.id, result, Some(photo.modified))?;
        println!(
            "Thumbnail: {} bytes",
            inference::thumbnail(&db, photo.id)?.len()
        );
    }
    let started = Instant::now();
    let result = db.search(&Search {
        query: "car".into(),
        ..Default::default()
    })?;
    println!(
        "Search 'car': {} results in {:?}",
        result.total,
        started.elapsed()
    );
    Ok(())
}
