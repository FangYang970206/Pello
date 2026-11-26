use pello_core::paths::Paths;
mod diagram;
mod window;
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
            // The size is the page's, as Electron's `useContentSize` makes it,
            // and logical units already carry the scale factor. The Linux menu
            // bar sits inside the window, so the page there is shorter than
            // the size asked for; on Windows it does not.
            let menu = if cfg!(target_os = "linux") {
                let dpi = std::env::var("GDK_DPI_SCALE").ok().and_then(|value| value.parse::<f64>().ok()).filter(|value| *value > 0.0).unwrap_or(1.0);
                [(1.0, 28.0), (1.25, 27.0), (1.5, 25.0), (2.0, 24.0)].into_iter().find(|(scale, _)| (dpi - scale).abs() < 0.02).map_or(28.0, |(_, gap)| gap)
            } else { 0.0 };
            let width = requested_width;
            let mut height = requested_height + menu;
            // Sizing a maximized window takes it out of maximizing first, and
            // the border it carries while changing is not the one it settles
            // on, so the window is back to normal before its size is set.
            if window.is_maximized().map_err(|error| error.to_string())? { window.unmaximize().map_err(|error| error.to_string())?; }
            window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })).map_err(|error| error.to_string())?;
            // An undecorated window on Windows keeps a border for its shadow,
            // and the window library counts that border into the size it sets,
            // by the same amount whatever the size. The size the window then
            // reports is taken off the one asked for, which leaves the page
            // exactly that size.
            if cfg!(windows) {
                let scale = window.scale_factor().map_err(|error| error.to_string())?;
                let inner = window.inner_size().map_err(|error| error.to_string())?;
                let gotten = inner.height as f64 / scale;
                if (gotten - height).abs() > 0.5 {
                    height -= gotten - height;
                    window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })).map_err(|error| error.to_string())?;
                }
            }
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
            let template = off_runtime(Arc::clone(state.inner()), template_channel, args).await?;
            popup_menu(&window, &template)
        }
        _ => off_runtime(Arc::clone(state.inner()), &channel, args).await,
    }
}

/// Runs a kernel call on a thread of its own and waits for it. The kernel is
/// synchronous and can block for as long as a file read, a Git command or an
/// SSH connection takes; its SSH client also waits on a runtime of its own,
/// from inside the call. Both are wrong on a thread of this command's own
/// runtime, which cannot make progress while it is held: a password SSH call
/// made from there never returned.
async fn off_runtime(workbench: Arc<Workbench>, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let channel = channel.to_string();
    // The place in line is taken here, where the call has arrived and before
    // it goes to its thread: the threads do not keep that order.
    let ticket = Workbench::SAVED_CHANNELS.contains(&channel.as_str()).then(|| workbench.save_order().ticket());
    tauri::async_runtime::spawn_blocking(move || {
        let _passed = ticket.as_ref().map(|ticket| ticket.wait());
        workbench.dispatch(&channel, &args)
    })
    .await
    .map_err(|error| format!("{error:?}"))?
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
            // The web views store under the data directory, which the
            // workbench takes with it.
            let webview_data = paths.data.clone();
            let handle = app.handle().clone();
            let workbench = Workbench::open(paths, Arc::new(move |event| {
                let _ = handle.emit("awb", &event);
            })).map_err(|error| -> Box<dyn std::error::Error> {
                eprintln!("{error}");
                Box::new(std::io::Error::other(error))
            })?;
            let workbench = Arc::new(workbench);
            // The workbench window opens in the saved theme's color, hidden
            // until its page is ready, as the Electron build opens it.
            let theme = workbench.dispatch("db:get", &[]).ok()
                .and_then(|db| db["db"]["settings"]["theme"].as_str().map(str::to_string))
                .unwrap_or_else(|| "light".to_string());
            window::open(app, &theme, &webview_data).map_err(|error| -> Box<dyn std::error::Error> { Box::new(std::io::Error::other(error.to_string())) })?;
            // Diagrams are drawn in a hidden window of this app, as the
            // Electron build draws them. It is managed before the workbench so
            // the command it calls finds it from the start.
            let renderer = diagram::WindowRenderer::new(app.handle(), &webview_data);
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
