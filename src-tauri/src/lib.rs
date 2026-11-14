use pello_core::paths::Paths;
use pello_core::workbench::Workbench;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Window};

#[tauri::command]
fn awb(window: Window, state: State<Arc<Workbench>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    match channel.as_str() {
        "win:min" => {
            window.minimize().map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "win:max" => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize().map_err(|error| error.to_string())?;
            } else {
                window.maximize().map_err(|error| error.to_string())?;
            }
            Ok(Value::Null)
        }
        "win:close" => {
            window.close().map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "win:resize" => {
            let width = args.first().and_then(|value| value.as_f64()).unwrap_or(1280.0).max(1024.0);
            let height = args.get(1).and_then(|value| value.as_f64()).unwrap_or(800.0).max(680.0);
            window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        _ => state.dispatch(&channel, &args),
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let debug_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let installation = if cfg!(debug_assertions) {
                debug_dir
            } else {
                std::env::current_exe().ok().and_then(|path| path.parent().map(|parent| parent.to_path_buf())).unwrap_or(debug_dir)
            };
            let paths = Paths::resolve(&installation);
            let handle = app.handle().clone();
            let workbench = Workbench::open(paths, Arc::new(move |event| {
                let _ = handle.emit("awb", &event);
            })).map_err(|error| -> Box<dyn std::error::Error> {
                eprintln!("{error}");
                Box::new(std::io::Error::other(error))
            })?;
            app.manage(Arc::new(workbench));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![awb])
        .run(tauri::generate_context!())
        .expect("error while running Pello");
}
