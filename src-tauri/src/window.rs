//! The workbench window, the counterpart of the Electron build's `BrowserWindow`
//! in `src/main/index.ts`.
//!
//! It is created hidden, in the color of the saved theme's sidebar, and shown
//! once its page has loaded, as Electron shows its window on `ready-to-show`:
//! a window that appears before its page is ready flashes first.

use std::path::{Path, PathBuf};
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Where the web view keeps what it stores: local storage, cache and cookies.
/// It is under the workbench's data directory, so it is the install's own
/// `data` folder and is isolated by `AWB_USER_DATA` with everything else, as
/// the Electron build's profile is.
///
/// Two web views can share a data directory only when they are started with
/// the same browser arguments. Without a directory each view takes the one
/// WebView2 derives from the app's identifier, which every running copy of the
/// app then shares, and a second copy fails to create its view.
pub fn webview_data(data: &Path) -> PathBuf {
    data.join("webview")
}

/// The sidebar color of each theme, as `src/shared/themes.ts` names it.
fn sidebar(theme: &str) -> tauri::webview::Color {
    let (red, green, blue) = match theme {
        "dark" => (0x13, 0x14, 0x17),
        "nord" => (0x2e, 0x34, 0x40),
        "dracula" => (0x21, 0x22, 0x2c),
        "catppuccin" => (0x1e, 0x1e, 0x2e),
        "solarized-light" => (0xee, 0xe8, 0xd5),
        // `light`, which is also what an unknown theme falls back to.
        _ => (0xf3, 0xf3, 0xf5),
    };
    tauri::webview::Color(red, green, blue, 255)
}

/// Create the main window hidden and show it when its page is ready. The
/// theme is known before the window exists, so the color is right from the
/// first frame. `data` is the workbench's data directory.
pub fn open(app: &tauri::App, theme: &str, data: &Path) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(PathBuf::from("index.html")))
        .title("Pello")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 680.0)
        .decorations(false)
        .resizable(true)
        .visible(false)
        .background_color(sidebar(theme))
        .data_directory(webview_data(data))
        .on_page_load(|window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished { return }
            let _ = window.show();
        })
        .build()?;
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::{sidebar, webview_data};
    use std::path::Path;

    #[test]
    fn the_web_view_stores_under_the_data_directory() {
        // The isolated directory a test gives, and the install's own `data`.
        assert_eq!(webview_data(Path::new(r"C:\Users\me\AppData\Local\Temp\pello-check-1")), Path::new(r"C:\Users\me\AppData\Local\Temp\pello-check-1\webview"));
        assert_eq!(webview_data(Path::new(r"D:\Apps\Pello\data")), Path::new(r"D:\Apps\Pello\data\webview"));
    }

    #[test]
    fn the_window_takes_the_sidebar_color_of_the_saved_theme() {
        let cases = [
            ("light", (0xf3, 0xf3, 0xf5)),
            ("dark", (0x13, 0x14, 0x17)),
            ("nord", (0x2e, 0x34, 0x40)),
            ("dracula", (0x21, 0x22, 0x2c)),
            ("catppuccin", (0x1e, 0x1e, 0x2e)),
            ("solarized-light", (0xee, 0xe8, 0xd5)),
        ];
        for (theme, (red, green, blue)) in cases {
            assert_eq!(sidebar(theme), tauri::webview::Color(red, green, blue, 255), "{theme}");
        }
    }

    #[test]
    fn an_unknown_theme_opens_light() {
        assert_eq!(sidebar("nord-light"), sidebar("light"));
        assert_eq!(sidebar(""), sidebar("light"));
    }
}
