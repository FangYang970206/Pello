//! The editing roles of a menu: cutting, copying, pasting and selecting in
//! the page's focused control, as Electron's roles act on the focused frame.
//!
//! WebView2 has no command interface for these, so the keys that stand for
//! them are sent to the page over the DevTools protocol. The browser runs its
//! own editing command on them, which is what lets a paste through where page
//! script's `execCommand('paste')` is refused without a gesture, and what
//! reaches the focused frame of an HTML preview, which page script cannot.

use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
};
use windows_core::PCWSTR;

/// The key of each role: its letter, and whether Shift goes with it.
fn keys(edit: &str) -> Option<(u8, bool)> {
    match edit {
        "cut" => Some((b'X', false)),
        "copy" => Some((b'C', false)),
        "paste" => Some((b'V', false)),
        "pasteAndMatchStyle" => Some((b'V', true)),
        "selectAll" => Some((b'A', false)),
        _ => None,
    }
}

/// Whether the word stands for one of the roles.
pub fn is_role(edit: &str) -> bool {
    keys(edit).is_some()
}

/// A wide string that lives as long as the call it is passed to.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

unsafe fn send(webview: &ICoreWebView2, method: &str, parameters: &str) {
    let name = wide(method);
    let params = wide(parameters);
    // Nothing comes back that is waited for; the handler only keeps the
    // object alive until the browser has taken the call.
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_error, _result| Ok(())));
    let _ = webview.CallDevToolsProtocolMethod(
        PCWSTR::from_raw(name.as_ptr()),
        PCWSTR::from_raw(params.as_ptr()),
        &handler,
    );
}

/// Carry out the role on the page's focused control.
pub fn run(window: &tauri::WebviewWindow, edit: &str) {
    let Some((key, shift)) = keys(edit) else { return };
    // Control is 2 and Shift 8, as the DevTools protocol counts modifiers.
    let modifiers = if shift { 10 } else { 2 };
    let letter = (key as char).to_string();
    let code = format!("Key{letter}");
    let page = window.clone();
    let _ = page.with_webview(move |webview| unsafe {
        let webview = webview.controller().CoreWebView2().expect("the page's webview");
        for kind in ["keyDown", "keyUp"] {
            send(&webview, "Input.dispatchKeyEvent", &format!(
                "{{\"type\":\"{kind}\",\"modifiers\":{modifiers},\"key\":\"{letter}\",\"code\":\"{code}\",\"windowsVirtualKeyCode\":{key}}}"
            ));
        }
    });
}
