use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

/// The file Windows asked us to open (double-click / "Open with"), handed to the UI once.
struct LaunchFile(Mutex<Option<String>>);

#[tauri::command]
fn launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut f| f.take())
}

/// Reads a file and returns its bytes as a binary IPC response (no JSON/base64 overhead).
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{} doesn't exist any more.", path.display()),
            std::io::ErrorKind::PermissionDenied => {
                format!("Windows didn't allow reading {}. It may be open in another app.", path.display())
            }
            _ => format!("Couldn't read {}: {e}", path.display()),
        })
}

fn file_from_args() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && PathBuf::from(a).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchFile(Mutex::new(file_from_args())))
        .invoke_handler(tauri::generate_handler![launch_file, read_file])
        .run(tauri::generate_context!())
        .expect("error while running PDForge");
}
