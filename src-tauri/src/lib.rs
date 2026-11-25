use pello_core::paths::Paths;
mod diagram;
use pello_core::workbench::Workbench;
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager, State, Window};

#[tauri::command]
async fn awb(window: Window, state: State<'_, Arc<Workbench>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
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
            // Return before the processes exit so a create that arrives during
            // cleanup is rejected, matching Electron's closing window.
            if state.begin_shutdown() {
                let workbench = Arc::clone(&state);
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    workbench.shutdown_sessions();
                    app.exit(0);
                });
            }
            Ok(Value::Null)
        }
        "win:resize" => {
            let requested_width = args.first().and_then(|value| value.as_f64()).unwrap_or(1280.0).max(1024.0);
            let requested_height = args.get(1).and_then(|value| value.as_f64()).unwrap_or(800.0).max(680.0);
            // GTK logical size is CSS pixels times the DPI scale. Electron's content size is the CSS viewport.
            let dpi = std::env::var("GDK_DPI_SCALE").ok().and_then(|value| value.parse::<f64>().ok()).filter(|value| *value > 0.0).unwrap_or(1.0);
            // The Linux menu bar sits inside the window, so the WebKit viewport is shorter than the logical height.
            let menu = [(1.0, 28.0), (1.25, 27.0), (1.5, 25.0), (2.0, 24.0)].into_iter()
                .find(|(scale, _)| (dpi - scale).abs() < 0.02).map_or(28.0, |(_, gap)| gap);
            window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: requested_width * dpi,
                height: (requested_height + menu) * dpi,
            })).map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "preview:menu" => {
            let mut language = "zh-CN".to_string();
            if let Ok(db) = state.dispatch("db:get", &[]) {
                if let Some(value) = db["db"]["settings"]["language"].as_str() { language = value.to_string(); }
            }
            let source = pello_core::i18n::translate(&language, "源码模式", &[] as &[String]);
            let copy = pello_core::i18n::translate(&language, "复制", &[] as &[String]);
            let select_all = pello_core::i18n::translate(&language, "全选", &[] as &[String]);
            let template = serde_json::json!([
                { "id": "source", "label": source },
                { "id": "copy", "label": copy },
                { "id": "selectAll", "label": select_all }
            ]);
            popup_menu(&window, &template)
        }
        "terminal:menu" | "file:menu" | "tree:menu" => {
            let template_channel = match channel.as_str() {
                "terminal:menu" => "menu:terminal",
                "file:menu" => "menu:file",
                _ => "menu:tree",
            };
            let template = state.dispatch(template_channel, &args)?;
            popup_menu(&window, &template)
        }
        _ => state.dispatch(&channel, &args),
    }
}

fn menu_choice_enabled(template: &Value, choice: &str) -> bool {
    template.as_array().map(|items| items.iter().any(|item| item["id"].as_str() == Some(choice) && item["enabled"].as_bool().unwrap_or(true))).unwrap_or(false)
}

fn popup_menu(window: &Window, template: &Value) -> Result<Value, String> {
    use tauri::menu::{ContextMenu, Menu, MenuItem};
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window.on_menu_event(move |_window, event| {
        let _ = sender.send(event.id.0.clone());
    });
    let app = window.app_handle();
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for item in template.as_array().cloned().unwrap_or_default() {
        let id = item["id"].as_str().unwrap_or("");
        if id.is_empty() { continue; }
        let label = item["label"].as_str().unwrap_or(id);
        let enabled = item["enabled"].as_bool().unwrap_or(true);
        let entry = MenuItem::with_id(app, id, label, enabled, None::<&str>).map_err(|error| error.to_string())?;
        menu.append(&entry).map_err(|error| error.to_string())?;
    }
    if let Ok(path) = std::env::var("AWB_MENU_FILE") {
        let _ = std::fs::write(format!("{path}.json"), template.to_string());
        let choice = std::fs::read_to_string(&path).unwrap_or_default();
        let choice = choice.trim().to_string();
        let _ = std::fs::write(&path, "");
        if choice.is_empty() { return Ok(Value::Null) }
        return Ok(if menu_choice_enabled(template, &choice) { serde_json::json!(choice) } else { Value::Null });
    }
    if let Ok(choice) = std::env::var("AWB_MENU_CHOICE") {
        if choice.is_empty() { return Ok(Value::Null) }
        return Ok(if menu_choice_enabled(template, &choice) { serde_json::json!(choice) } else { Value::Null });
    }
    if menu.popup(window.clone()).is_err() {
        return Ok(Value::Null);
    }
    match receiver.try_recv() {
        Ok(id) => Ok(serde_json::json!(id)),
        Err(_) => Ok(Value::Null),
    }
}

fn install_app_menu(app: &tauri::App) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let template = pello_core::menu::app_menu("zh-CN");
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for group in template.as_array().cloned().unwrap_or_default() {
        let id = group["id"].as_str().unwrap_or("menu");
        let label = group["label"].as_str().unwrap_or(id);
        let submenu = Submenu::with_id(app, id, label, true).map_err(|error| error.to_string())?;
        for item in group["items"].as_array().cloned().unwrap_or_default() {
            let item_id = item["id"].as_str().unwrap_or("");
            if item_id.is_empty() { continue }
            let entry = MenuItem::with_id(app, item_id, item["label"].as_str().unwrap_or(item_id), true, None::<&str>).map_err(|error| error.to_string())?;
            submenu.append(&entry).map_err(|error| error.to_string())?;
        }
        menu.append(&submenu).map_err(|error| error.to_string())?;
    }
    app.set_menu(menu).map(|_| ()).map_err(|error| error.to_string())
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
            let workbench = Arc::new(workbench);
            // Diagrams are drawn in a hidden window of this app, as the
            // Electron build draws them. It is managed before the workbench so
            // the command it calls finds it from the start.
            let renderer = diagram::WindowRenderer::new(app.handle());
            workbench.set_diagram_renderer(renderer.clone());
            app.manage(renderer);
            let ticking = workbench.clone();
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let _ = ticking.poll_updates(started.elapsed().as_millis() as u64);
                }
            });
            app.manage(workbench);
            install_app_menu(app).map_err(|error| -> Box<dyn std::error::Error> { Box::new(std::io::Error::other(error)) })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![awb, diagram::diagram_result])
        .run(tauri::generate_context!())
        .expect("error while running Pello");
}
