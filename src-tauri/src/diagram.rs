//! Draws a diagram in a hidden window of this app, the counterpart of the
//! Electron build's `src/main/diagram-renderer.ts`.
//!
//! The window loads the bundled `diagram-renderer.html` and nothing else: it
//! may not navigate anywhere, and the one capability that names it grants a
//! single command, `diagram_result`. So the page can hand back the SVG it drew
//! and nothing more: it has no workbench command, no plugin, no Node.
//!
//! A web view's script evaluation does not wait for a promise, which is why
//! the page reports the result instead of the evaluation returning it.

use pello_core::preview::DiagramRenderer;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The window's label; the capability `diagram` names the same one.
const LABEL: &str = "diagram";
/// The Electron build gives up on a diagram after this long and rebuilds its window.
const LIMIT: Duration = Duration::from_secs(15);
const CANCELLED: &str = "图表渲染已取消";
const TIMED_OUT: &str = "图表渲染超时，请简化图表后重试";
const NO_SVG: &str = "图表渲染未返回 SVG";

/// One diagram the page has been asked for and not yet answered.
struct Waiting {
    sender: SyncSender<Result<String, String>>,
}

struct State {
    /// The window whose page is the one to draw in.
    current: u64,
    /// False until the current window's page has finished loading.
    loaded: bool,
    waiting: HashMap<String, Waiting>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    next_window: AtomicU64,
    next_id: AtomicU64,
}

pub struct WindowRenderer {
    app: AppHandle,
    shared: Arc<Shared>,
}

/// The page hands back what it drew. Only the window named by the capability
/// can reach this command, and an id no diagram waits for is ignored.
#[tauri::command]
pub fn diagram_result(renderer: tauri::State<'_, Arc<WindowRenderer>>, window: WebviewWindow, id: String, svg: Option<String>, error: Option<String>) -> Result<(), String> {
    renderer.report(&id, svg, error, window.label() == LABEL)
}

impl WindowRenderer {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            shared: Arc::new(Shared {
                state: Mutex::new(State { current: 0, loaded: false, waiting: HashMap::new() }),
                changed: Condvar::new(),
                next_window: AtomicU64::new(1),
                next_id: AtomicU64::new(1),
            }),
        })
    }

    /// Hand the result to the diagram waiting for `id`, if there is one and it
    /// comes from the drawing window.
    fn report(&self, id: &str, svg: Option<String>, error: Option<String>, from_window: bool) -> Result<(), String> {
        if !from_window { return Ok(()) }
        let result = match (svg, error) {
            (Some(svg), None) if svg.contains("<svg") => Ok(svg),
            (Some(_), None) => Err(NO_SVG.to_string()),
            (_, error) => Err(error.unwrap_or_else(|| NO_SVG.to_string())),
        };
        let mut state = self.shared.state.lock().expect("diagram state");
        let answered = match state.waiting.remove(id) {
            Some(waiting) => waiting.sender.send(result).is_ok(),
            None => false,
        };
        drop(state);
        self.shared.changed.notify_all();
        if answered { Ok(()) } else { Err("no diagram waits for this id".to_string()) }
    }

    /// The window for drawing, created on the first diagram and again after
    /// every reset. It is never shown and holds only the bundled page.
    fn open_window(&self) -> Result<WebviewWindow, String> {
        let shared = Arc::clone(&self.shared);
        // Each window has its own number. A page-load report from a window
        // that was reset meanwhile must not pass for the new one's.
        let number = shared.next_window.fetch_add(1, Ordering::SeqCst);
        shared.state.lock().expect("diagram state").current = number;
        WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::App(PathBuf::from("diagram-renderer.html")))
            .title("Pello diagram renderer")
            .inner_size(1440.0, 900.0)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            // Nothing the page stores reaches the disk or the main window's
            // profile, as the Electron build's own `partition` keeps it apart.
            .incognito(true)
            // Only the bundled page may be loaded, whatever a diagram asks
            // for. The app's own origin is `tauri.localhost` in a build and
            // `localhost` on the development server.
            .on_navigation(|url| {
                matches!(url.scheme(), "http" | "https" | "tauri")
                    && matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
                    && url.path() == "/diagram-renderer.html"
            })
            .on_page_load(move |window, payload| {
                if window.label() != LABEL || payload.event() != tauri::webview::PageLoadEvent::Finished { return }
                let mut state = shared.state.lock().expect("diagram state");
                if state.current != number { return }
                state.loaded = true;
                shared.changed.notify_all();
            })
            .build()
            .map_err(|error| error.to_string())
    }

    /// The existing window, or a new one; then wait until its page can draw.
    fn ready_window(&self, deadline: Instant) -> Result<WebviewWindow, String> {
        let window = match self.app.get_webview_window(LABEL) {
            Some(window) => window,
            None => self.open_window()?,
        };
        let mut state = self.shared.state.lock().expect("diagram state");
        while !state.loaded {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { return Err(TIMED_OUT.to_string()) }
            let (updated, _) = self.shared.changed.wait_timeout(state, left).expect("diagram state");
            state = updated;
        }
        Ok(window)
    }

    /// Ask the page for the diagram and wait for it to report the SVG.
    fn draw(&self, window: &WebviewWindow, source: &str, deadline: Instant) -> Result<String, String> {
        let id = format!("diagram-{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.shared.state.lock().expect("diagram state").waiting.insert(id.clone(), Waiting { sender });
        // The source is a JSON string literal, so a diagram cannot break out
        // of the call, whatever quotes or backslashes it holds.
        let script = format!(
            "window.renderMermaid({source}, {id}).then(\n  (svg) => window.__TAURI_INTERNALS__.invoke('diagram_result', {{ id: {id}, svg }}),\n  (error) => window.__TAURI_INTERNALS__.invoke('diagram_result', {{ id: {id}, error: String(error && error.message ? error.message : error) }}),\n)",
            source = serde_json::to_string(source).unwrap_or_else(|_| "\"\"".to_string()),
            id = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_string()),
        );
        window.eval(script).map_err(|error| {
            self.shared.state.lock().expect("diagram state").waiting.remove(&id);
            error.to_string()
        })?;
        loop {
            // The page answers, or a reset answers for it.
            match receiver.try_recv() {
                Ok(result) => return result,
                Err(TryRecvError::Disconnected) => return Err(CANCELLED.to_string()),
                Err(TryRecvError::Empty) => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                self.shared.state.lock().expect("diagram state").waiting.remove(&id);
                return Err(TIMED_OUT.to_string());
            }
            std::thread::sleep(left.min(Duration::from_millis(20)));
        }
    }
}

impl DiagramRenderer for WindowRenderer {
    /// Diagrams reach this one at a time, each on the thread that asked.
    fn render(&self, source: &str, _generation: u64) -> Result<String, String> {
        let deadline = Instant::now() + LIMIT;
        let window = self.ready_window(deadline)?;
        self.draw(&window, source, deadline)
    }

    /// The diagram being drawn is abandoned and its window closed, so a page
    /// that stopped answering is never asked again; the next diagram opens a
    /// new one.
    fn reset(&self) {
        let mut state = self.shared.state.lock().expect("diagram state");
        state.loaded = false;
        let waiting = std::mem::take(&mut state.waiting);
        drop(state);
        for (_, Waiting { sender }) in waiting { let _ = sender.send(Err(CANCELLED.to_string())); }
        if let Some(window) = self.app.get_webview_window(LABEL) { let _ = window.destroy(); }
    }
}
