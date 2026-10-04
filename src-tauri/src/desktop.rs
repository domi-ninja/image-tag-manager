use crate::{
    db::{Classification, Db, Folder, Page, Search, Stats, Tag},
    engine::{Engine, Status},
    inference,
};
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
type AppState = Arc<Engine>;
type Response<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[tauri::command]
fn folders(s: State<AppState>) -> Response<Vec<Folder>> {
    s.db.folders().map_err(err)
}
#[tauri::command]
fn add_folder(s: State<AppState>, path: String) -> Response<()> {
    s.db.add_folder(&path).map_err(err)?;
    if !s.status().map_err(err)?.busy {
        s.start("scan").map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
fn save_folder(s: State<AppState>, folder: Folder) -> Response<()> {
    s.db.save_folder(folder).map_err(err)
}
#[tauri::command]
fn remove_folder(s: State<AppState>, id: i64) -> Response<()> {
    if s.status().map_err(err)?.busy {
        return Err("Pause the current task before removing a folder".into());
    }
    s.db.remove_folder(id).map_err(err)
}
#[tauri::command]
fn search(s: State<AppState>, filter: Search) -> Response<Page> {
    s.db.search(&filter).map_err(err)
}
#[tauri::command]
fn tags(s: State<AppState>, folder_id: Option<i64>) -> Response<Vec<Tag>> {
    s.db.tags(folder_id).map_err(err)
}
#[tauri::command]
fn stats(s: State<AppState>) -> Response<Stats> {
    s.db.stats().map_err(err)
}
#[tauri::command]
fn status(s: State<AppState>) -> Response<Status> {
    s.status().map_err(err)
}
#[tauri::command]
fn start(s: State<AppState>, action: String) -> Response<()> {
    s.start(&action).map_err(err)
}
#[tauri::command]
fn pause(s: State<AppState>) -> Response<()> {
    s.pause().map_err(err)
}
#[tauri::command]
fn automatic(s: State<AppState>, enabled: bool) -> Response<()> {
    s.automatic(enabled).map_err(err)
}
#[tauri::command]
fn retry(s: State<AppState>, folder_id: Option<i64>) -> Response<()> {
    s.db.retry(folder_id).map_err(err)
}
#[tauri::command]
fn save_photo(s: State<AppState>, id: i64, classification: Classification) -> Response<()> {
    s.db.store(id, classification, None).map_err(err)?;
    Ok(())
}
#[tauri::command]
async fn thumbnail(s: State<'_, AppState>, id: i64) -> Response<String> {
    let db = s.db.clone();
    tauri::async_runtime::spawn_blocking(move || inference::thumbnail(&db, id).map_err(err))
        .await
        .map_err(err)?
}
#[tauri::command]
async fn preview(s: State<'_, AppState>, id: i64) -> Response<String> {
    let db = s.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = db.photo(id).map_err(err)?;
        Ok(inference::data_url(
            &inference::jpeg(std::path::Path::new(&p.path), 1600).map_err(err)?,
        ))
    })
    .await
    .map_err(err)?
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum ImageAction {
    CopyImage,
    CopyPath,
    Reveal,
    Open,
}

#[tauri::command]
async fn image_action(
    app: tauri::AppHandle,
    s: State<'_, AppState>,
    id: i64,
    action: ImageAction,
) -> Response<()> {
    let db = s.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let photo = db.photo(id).map_err(err)?;
        if matches!(action, ImageAction::CopyPath) {
            return app.clipboard().write_text(photo.path).map_err(err);
        }
        let path = std::path::Path::new(&photo.path);
        if !path.is_file() {
            return Err("Image could not be found. It may have moved.".into());
        }
        match action {
            ImageAction::CopyImage => {
                let pixels = inference::rgba(path).map_err(err)?;
                let (width, height) = pixels.dimensions();
                let image = tauri::image::Image::new_owned(pixels.into_raw(), width, height);
                app.clipboard().write_image(&image).map_err(err)
            }
            ImageAction::Reveal => app.opener().reveal_item_in_dir(path).map_err(err),
            ImageAction::Open => app
                .opener()
                .open_path(photo.path, None::<&str>)
                .map_err(err),
            ImageAction::CopyPath => unreachable!(),
        }
    })
    .await
    .map_err(err)?
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<AppState>().shutdown();
            }
        })
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            let db = Db::new(root)?;
            let mut runtime = app.path().resource_dir()?.join("runtime");
            if cfg!(debug_assertions) {
                runtime = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
            }
            let engine = Engine::new(db, runtime);
            engine.monitor();
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            folders,
            add_folder,
            save_folder,
            remove_folder,
            search,
            tags,
            stats,
            status,
            start,
            pause,
            automatic,
            retry,
            save_photo,
            thumbnail,
            preview,
            image_action
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize Image Shelf");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<AppState>().shutdown();
        }
    });
}
