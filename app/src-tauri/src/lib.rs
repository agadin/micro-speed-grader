pub mod slide;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use slide::{SlideInfo, SlideRegistry};
use tauri::http::{Response, StatusCode};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn open_slide(state: tauri::State<'_, Arc<SlideRegistry>>, path: String) -> Result<SlideInfo, String> {
    let reg = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reg.open(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Recursively list files under `dir` whose name ends with one of `suffixes`
/// (case-insensitive). Hidden files and macOS resource forks are skipped.
#[tauri::command]
fn list_files(dir: String, suffixes: Vec<String>) -> Result<Vec<String>, String> {
    fn walk(p: &Path, suffixes: &[String], out: &mut Vec<String>) -> std::io::Result<()> {
        for e in std::fs::read_dir(p)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            let path = e.path();
            if path.is_dir() {
                walk(&path, suffixes, out)?;
            } else {
                let lower = name.to_lowercase();
                if suffixes.is_empty() || suffixes.iter().any(|s| lower.ends_with(&s.to_lowercase())) {
                    out.push(path.to_string_lossy().to_string());
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(Path::new(&dir), &suffixes, &mut out).map_err(|e| format!("{dir}: {e}"))?;
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    // .ndpa files are UTF-8, but be forgiving about BOMs / stray bytes
    let s = String::from_utf8_lossy(&bytes);
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

#[tauri::command]
fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Crash-safe write: write to a temp file, then rename over the target.
/// Keeps the previous version as `<file>.bak`.
#[tauri::command]
fn write_text(path: String, contents: String, keep_backup: Option<bool>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("tmp-write");
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    if keep_backup.unwrap_or(false) && target.exists() {
        let mut bak = target.clone().into_os_string();
        bak.push(".bak");
        let _ = std::fs::copy(&target, PathBuf::from(bak));
    }
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Preferences live in their own window (index.html?window=preferences); settings are
/// shared with the main window through localStorage.
#[tauri::command]
fn open_preferences<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("preferences") {
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(&app, "preferences", tauri::WebviewUrl::App("index.html?window=preferences".into()))
        .title("Preferences")
        .inner_size(680.0, 560.0)
        .min_inner_size(560.0, 420.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn tile_response(reg: &SlideRegistry, uri_path: &str) -> Response<Vec<u8>> {
    // /<id>/<level>/<x>_<y>.jpg
    let parts: Vec<&str> = uri_path.trim_start_matches('/').split('/').collect();
    let parsed = (|| {
        let id: u32 = parts.first()?.parse().ok()?;
        let level: u32 = parts.get(1)?.parse().ok()?;
        let file = parts.get(2)?.trim_end_matches(".jpg");
        let (x, y) = file.split_once('_')?;
        Some((id, level, x.parse::<u32>().ok()?, y.parse::<u32>().ok()?))
    })();
    let not_found = |msg: String| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Access-Control-Allow-Origin", "*")
            .body(msg.into_bytes())
            .unwrap()
    };
    let Some((id, level, x, y)) = parsed else {
        return not_found("bad tile path".into());
    };
    let Some(slide) = reg.get(id) else {
        return not_found("unknown slide".into());
    };
    match slide.render_tile(level, x, y, 85) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", "image/jpeg")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "max-age=31536000")
            .body(bytes)
            .unwrap(),
        Err(e) => not_found(e),
    }
}

/// Native menu bar. On macOS the first submenu is the app menu
/// ("Micro Speed Grader ▸ Preferences… ⌘,"); on Windows it shows as a File menu.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let prefs = MenuItem::with_id(app, "preferences", "Preferences…", true, Some("CmdOrCtrl+,"))?;
    let new_s = MenuItem::with_id(app, "new_session", "New Grading Session…", true, Some("CmdOrCtrl+N"))?;
    let open_s = MenuItem::with_id(app, "open_session", "Open Session…", true, Some("CmdOrCtrl+O"))?;
    let export = MenuItem::with_id(app, "export", "Export Grades…", true, Some("CmdOrCtrl+E"))?;
    let close_s = MenuItem::with_id(app, "close_session", "Close Session", true, Some("CmdOrCtrl+W"))?;
    let updates = MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "Micro Speed Grader",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Micro Speed Grader"), None)?,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &prefs,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = {
        #[cfg(target_os = "macos")]
        {
            Submenu::with_items(app, "File", true, &[&new_s, &open_s, &PredefinedMenuItem::separator(app)?, &export, &PredefinedMenuItem::separator(app)?, &close_s])?
        }
        #[cfg(not(target_os = "macos"))]
        {
            Submenu::with_items(
                app,
                "File",
                true,
                &[&new_s, &open_s, &PredefinedMenuItem::separator(app)?, &export, &prefs, &updates, &PredefinedMenuItem::separator(app)?, &close_s, &PredefinedMenuItem::quit(app, None)?],
            )?
        }
    };

    // Edit menu is required on macOS for copy/paste/select-all in text fields.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    #[cfg(target_os = "macos")]
    return Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu]);
    #[cfg(not(target_os = "macos"))]
    return Menu::with_items(app, &[&file_menu, &edit_menu, &window_menu]);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(SlideRegistry::default());
    let reg_for_protocol = registry.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(registry)
        .register_asynchronous_uri_scheme_protocol("slide", move |_ctx, request, responder| {
            let reg = reg_for_protocol.clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(tile_response(&reg, &path));
            });
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Micro Speed Grader");
            }
            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "preferences" {
                let _ = open_preferences(app.clone());
            } else if matches!(id, "new_session" | "open_session" | "export" | "close_session") {
                let _ = app.emit("menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_slide,
            list_files,
            read_text,
            read_bytes,
            write_text,
            path_exists,
            open_preferences
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
