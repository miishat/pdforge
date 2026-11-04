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

/// Reads a file and returns its bytes as a binary IPC response (no JSON/base64 overhead).
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFiles(Mutex::new(files_from_args(std::env::args(), None))))
        .invoke_handler(tauri::generate_handler![launch_files, read_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running PDForge");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_windows_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cme%5Cmy%20file.pdf"), "C:\\Users\\me\\my file.pdf");
        assert_eq!(percent_decode("%E2%82%AC.pdf"), "€.pdf");
        assert_eq!(percent_decode("plain.pdf"), "plain.pdf");
    }
}
