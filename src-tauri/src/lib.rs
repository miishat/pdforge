mod shell;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, State};

/// Files Windows asked us to open at launch (double-click / "Open with"), handed to the UI once.
struct LaunchFiles(Mutex<Vec<String>>);

#[tauri::command]
fn launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    state.0.lock().map(|mut f| std::mem::take(&mut *f)).unwrap_or_default()
}

/// The largest file PDForge opens. The PDF engine has 2 GB of working memory in all, and the file must fit in it
/// with room to spare. Keep in step with MAX_OPEN_BYTES in src/platform/index.ts.
const MAX_OPEN_BYTES: u64 = 1536 * 1024 * 1024;

fn too_large_message(name: &str, size: u64) -> String {
    format!(
        "{name} is {:.1} GB. PDForge can open files up to 1.5 GB: its PDF engine has 2 GB of working memory, and the whole file has to fit in it.",
        size as f64 / (1024.0 * 1024.0 * 1024.0)
    )
}

/// Reads a file and returns its bytes as a binary IPC response (no JSON/base64 overhead).
/// Files too large to open are refused before reading, with a message saying why.
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let size = std::fs::metadata(&path).map_err(|e| io_message(&path, "read", e))?.len();
    if size > MAX_OPEN_BYTES {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Err(too_large_message(&name, size));
    }
    std::fs::read(&path).map(Response::new).map_err(|e| io_message(&path, "read", e))
}

/// Writes the raw request body to the path in the `path` header, atomically:
/// the data goes to a temporary file next to the target, which then replaces it.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents.".into());
    };
    let encoded = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing file path.")?;
    let path = PathBuf::from(percent_decode(encoded));
    let tmp = path.with_extension(format!(
        "{}.pdforge-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| io_message(&path, "save", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_message(&path, "save", e)
    })
}

/// The Windows account name, used as the default author of comments.
/// Files in a folder with one of the given extensions (case-insensitive), optionally including
/// subfolders. Sorted by path; hidden and temporary files are skipped.
#[tauri::command]
async fn list_files(dir: String, extensions: Vec<String>, recursive: bool) -> Result<Vec<String>, String> {
    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let mut out = vec![];
    let mut stack = vec![PathBuf::from(&dir)];
    while let Some(d) = stack.pop() {
        let entries = std::fs::read_dir(&d).map_err(|e| io_message(&d, "read", e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with("~$") || name.ends_with(".pdforge-tmp") {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if recursive {
                    stack.push(path);
                }
            } else if kind.is_file() {
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if exts.iter().any(|e| *e == ext) {
                    out.push(path.to_string_lossy().to_string());
                }
            }
            if out.len() > 10_000 {
                return Err("That folder has more than 10,000 matching files; choose a smaller one.".into());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn user_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Me".into())
}

/// Crash recovery: unsaved documents are copied here every so often and offered back on the next start.
fn recovery_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the recovery folder: {e}"))?;
    Ok(dir)
}

fn recovery_key(raw: &str) -> Result<String, String> {
    let key: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    if key.is_empty() {
        Err("Invalid recovery key.".into())
    } else {
        Ok(key)
    }
}

#[tauri::command]
async fn recovery_save(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected file contents.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(percent_decode)
            .ok_or(format!("Missing {name}."))
    };
    let key = recovery_key(&header("key")?)?;
    let meta = header("meta")?;
    let dir = recovery_dir(&app)?;
    let pdf = dir.join(format!("{key}.pdf"));
    let tmp = dir.join(format!("{key}.pdf.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &pdf).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{key}.json")), meta).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct RecoveryEntry {
    key: String,
    meta: String,
}

#[tauri::command]
fn recovery_list(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    let dir = recovery_dir(&app)?;
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let key = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        if dir.join(format!("{key}.pdf")).is_file() {
            if let Ok(meta) = std::fs::read_to_string(&path) {
                out.push(RecoveryEntry { key, meta });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn recovery_read(app: tauri::AppHandle, key: String) -> Result<Response, String> {
    let path = recovery_dir(&app)?.join(format!("{}.pdf", recovery_key(&key)?));
    std::fs::read(&path).map(Response::new).map_err(|e| io_message(&path, "read", e))
}

#[tauri::command]
fn recovery_clear(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    let key = recovery_key(&key)?;
    let _ = std::fs::remove_file(dir.join(format!("{key}.pdf")));
    let _ = std::fs::remove_file(dir.join(format!("{key}.json")));
    Ok(())
}

/// Saved page text of large PDFs, so their first search after reopening needn't read every page again.
/// One file per PDF, named by the SHA-256 of its contents. The UI keeps the folder under its size budget.
fn search_index_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))?
        .join("search-index");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the search data folder: {e}"))?;
    Ok(dir)
}

fn search_index_key(raw: &str) -> Result<String, String> {
    if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(raw.to_ascii_lowercase())
    } else {
        Err("Invalid search data key.".into())
    }
}

/// The saved text for a file, or an empty response if there is none. Reading marks it as recently used.
#[tauri::command]
async fn search_index_read(app: tauri::AppHandle, key: String) -> Result<Response, String> {
    let path = search_index_dir(&app)?.join(format!("{}.bin", search_index_key(&key)?));
    match std::fs::read(&path) {
        Ok(bytes) => {
            if let Ok(f) = std::fs::File::options().write(true).open(&path) {
                let _ = f.set_modified(std::time::SystemTime::now());
            }
            Ok(Response::new(bytes))
        }
        Err(_) => Ok(Response::new(Vec::<u8>::new())),
    }
}

#[tauri::command]
async fn search_index_write(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected search data.".into());
    };
    let key = request
        .headers()
        .get("key")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing search data key.")?;
    let dir = search_index_dir(&app)?;
    let key = search_index_key(key)?;
    let tmp = dir.join(format!("{key}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{key}.bin"))).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[derive(serde::Serialize)]
struct SearchIndexEntry {
    key: String,
    size: u64,
    /// Last used, in milliseconds since 1970.
    used: u64,
}

#[tauri::command]
fn search_index_list(app: tauri::AppHandle) -> Result<Vec<SearchIndexEntry>, String> {
    let dir = search_index_dir(&app)?;
    let mut out = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(key) = path.file_stem().and_then(|s| s.to_str()).and_then(|k| search_index_key(k).ok()) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let used = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SearchIndexEntry { key, size: meta.len(), used });
    }
    Ok(out)
}

#[tauri::command]
fn search_index_remove(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = search_index_dir(&app)?.join(format!("{}.bin", search_index_key(&key)?));
    let _ = std::fs::remove_file(path);
    Ok(())
}

/// Deletes all saved search data (files left over from interrupted writes too).
#[tauri::command]
fn search_index_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = search_index_dir(&app)?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if matches!(path.extension().and_then(|e| e.to_str()), Some("bin" | "tmp")) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

fn io_message(path: &PathBuf, verb: &str, e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => format!("{} doesn't exist any more.", path.display()),
        std::io::ErrorKind::PermissionDenied => format!(
            "Windows didn't allow PDForge to {verb} {}. It may be open in another app, or the folder may be protected.",
            path.display()
        ),
        _ => format!("Couldn't {verb} {}: {e}", path.display()),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn files_from_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&str>) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            match (p.is_relative(), cwd) {
                (true, Some(dir)) => PathBuf::from(dir).join(p),
                _ => p,
            }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch hands its files to this window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = files_from_args(argv, Some(&cwd));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if !files.is_empty() {
                    let _ = w.emit("open-files", files);
                }
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFiles(Mutex::new(files_from_args(std::env::args(), None))))
        .invoke_handler(tauri::generate_handler![
            launch_files,
            read_file,
            write_file,
            list_files,
            user_name,
            recovery_save,
            recovery_list,
            recovery_read,
            recovery_clear,
            search_index_read,
            search_index_write,
            search_index_list,
            search_index_remove,
            search_index_clear,
            shell::show_snap_layouts,
            shell::add_recent_document,
            shell::default_pdf_app,
            shell::open_default_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDForge");
}

#[cfg(test)]
mod tests {
    use super::{percent_decode, recovery_key, search_index_key, too_large_message};

    #[test]
    fn explains_files_that_are_too_large() {
        let m = too_large_message("scans.pdf", 2_576_980_378);
        assert!(m.starts_with("scans.pdf is 2.4 GB."), "{m}");
        assert!(m.contains("up to 1.5 GB"));
    }

    #[test]
    fn search_index_keys_are_hashes_only() {
        let hash = "a".repeat(64);
        assert_eq!(search_index_key(&hash).unwrap(), hash);
        assert_eq!(search_index_key(&"AB".repeat(32)).unwrap(), "ab".repeat(32));
        assert!(search_index_key("../evil").is_err());
        assert!(search_index_key(&format!("{}/", "a".repeat(63))).is_err());
    }

    #[test]
    fn recovery_keys_cannot_escape_the_folder() {
        assert_eq!(recovery_key("../../evil").unwrap(), "evil");
        assert_eq!(recovery_key("tab-12-abc").unwrap(), "tab-12-abc");
        assert!(recovery_key("../..").is_err());
    }

    #[test]
    fn decodes_windows_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cme%5Cmy%20file.pdf"), "C:\\Users\\me\\my file.pdf");
        assert_eq!(percent_decode("%E2%82%AC.pdf"), "€.pdf");
        assert_eq!(percent_decode("plain.pdf"), "plain.pdf");
    }
}
