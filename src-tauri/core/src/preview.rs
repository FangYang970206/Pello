//! Read-only project previews. HTML is served from a loopback socket.
//! Mermaid is rendered by a separate sandbox process with no workbench API and no Node permission.

use crate::files::clean_relative;
use crate::i18n::translate;
use crate::random_id;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PREVIEW_LIMIT: u64 = 12_000_000;
const DRAFT_LIMIT: usize = 2 * 1024 * 1024;

const BRIDGE: &str = r#"<script>(function(){
const send=(data)=>parent.postMessage(data,'*');
let searchOpen=false;
addEventListener('wheel',(event)=>{
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.deltaY){event.preventDefault();event.stopPropagation();send({type:'pello-preview-zoom',deltaY:event.deltaY});}
},{passive:false,capture:true});
addEventListener('keydown',(event)=>{
  if(event.isComposing)return;
  const key=event.key.toLowerCase();
  if(((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&(key==='f'||key==='h'))||(searchOpen&&(event.key==='F3'||event.key==='Escape'))){
    event.preventDefault();event.stopPropagation();send({type:'pello-preview-key',key:key,shift:event.shiftKey});
  }
},true);
addEventListener('message',(event)=>{
  if(event.source!==parent||!event.data||event.data.type!=='pello-preview-search')return;
  searchOpen=!!event.data.open;
  send({type:'pello-preview-text',text:(document.body&&document.body.innerText)||''});
});
})()</script>"#;

#[derive(Clone, Copy, Debug)]
pub struct WheelState {
    pub page: i32,
    pub zoom: f64,
    pub pending: f64,
}

/// Page changes only after the pointer rests on the page edge. Ctrl+wheel changes zoom and stays on the page.
pub fn pdf_wheel(state: WheelState, pages: i32, at_edge: bool, ctrl: bool, delta_y: f64) -> WheelState {
    let pages = pages.max(1);
    if ctrl && delta_y != 0.0 {
        return WheelState { page: state.page, zoom: (state.zoom + if delta_y < 0.0 { 0.1 } else { -0.1 }).clamp(0.25, 4.0), pending: 0.0 };
    }
    if !at_edge || delta_y == 0.0 { return WheelState { pending: 0.0, ..state }; }
    let pending = state.pending + delta_y;
    if pending.abs() < 60.0 { return WheelState { pending, ..state }; }
    let direction = if pending > 0.0 { 1 } else { -1 };
    WheelState { page: (state.page + direction).clamp(1, pages), zoom: state.zoom, pending: 0.0 }
}

struct Draft { token: String, text: String }
struct Project { token: String, root: PathBuf, drafts: HashMap<String, Draft>, language: String }

struct Diagrams {
    generation: AtomicU64,
    child: Mutex<Option<Child>>,
    gate: Mutex<()>,
}

struct Inner {
    alive: AtomicBool,
    port: Mutex<Option<u16>>,
    projects: Mutex<HashMap<String, Project>>,
    diagrams: Diagrams,
}

pub struct Service { inner: Arc<Inner> }

impl Service {
    pub fn new() -> Self {
        Self { inner: Arc::new(Inner {
            alive: AtomicBool::new(true),
            port: Mutex::new(None),
            projects: Mutex::new(HashMap::new()),
            diagrams: Diagrams { generation: AtomicU64::new(0), child: Mutex::new(None), gate: Mutex::new(()) },
        }) }
    }

    pub fn url(&self, project_id: &str, root: &Path, rel: &str, draft: Option<&str>, language: &str) -> Result<String, String> {
        let relative = normalize_rel(rel, language)?;
        let _ = read_asset(root, &relative, language)?;
        if let Some(draft) = draft {
            if !is_html(&relative) || draft.len() > DRAFT_LIMIT { return Err(translate(language, "预览草稿必须为 2 MB 以内的 HTML", &[] as &[String])); }
        }
        let port = self.ensure(language)?;
        let identity = format!("{project_id}:{}", root.display());
        let mut projects = self.inner.projects.lock().expect("preview");
        let entry = projects.entry(identity).or_insert_with(|| Project { token: random_id(), root: root.to_path_buf(), drafts: HashMap::new(), language: language.to_string() });
        entry.language = language.to_string();
        let mut query = String::new();
        if let Some(draft) = draft {
            let token = random_id();
            entry.drafts.insert(relative.clone(), Draft { token: token.clone(), text: draft.to_string() });
            query = format!("?draft={token}");
        }
        let encoded = relative.split('/').map(encode_component).collect::<Vec<_>>().join("/");
        Ok(format!("http://127.0.0.1:{port}/{}/{}{query}", entry.token, encoded))
    }

    pub fn render_mermaid(&self, source: &str, language: &str) -> Result<String, String> {
        if source.trim().is_empty() || source.chars().count() > 100_000 {
            return Err(translate(language, "Mermaid 内容为空或超过 100000 字符", &[] as &[String]));
        }
        let _gate = self.inner.diagrams.gate.lock().expect("diagram");
        let generation = self.inner.diagrams.generation.load(Ordering::SeqCst);
        if generation != self.inner.diagrams.generation.load(Ordering::SeqCst) {
            return Err(translate(language, "图表渲染已取消", &[] as &[String]));
        }
        if let Some(bin) = std::env::var("AWB_DIAGRAM_BIN").ok().filter(|value| !value.is_empty()) {
            return self.render_external(&bin, source, generation, language);
        }
        self.render_browser(source, generation, language)
    }

    fn render_external(&self, bin: &str, source: &str, generation: u64, language: &str) -> Result<String, String> {
        let mut command = Command::new(bin);
        command.env_clear();
        if let Some(path) = std::env::var_os("PATH") { command.env("PATH", path); }
        command.args(["--security-level", "strict", "--sandbox", "--no-node", "--no-workbench"]);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        let mut child = command.spawn().map_err(|_| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let mut stdout = child.stdout.take().ok_or_else(|| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let reader = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = stdout.read_to_end(&mut buf); buf });
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(source.as_bytes()); }
        {
            let mut slot = self.inner.diagrams.child.lock().expect("child");
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                stop_child(&mut child);
                drop(slot);
                let _ = reader.join();
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            *slot = Some(child);
        }
        let started = Instant::now();
        loop {
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                self.stop_diagram();
                let _ = reader.join();
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            if started.elapsed() > Duration::from_secs(15) {
                self.stop_diagram();
                let _ = reader.join();
                return Err(translate(language, "图表渲染超时，请简化图表后重试", &[] as &[String]));
            }
            let finished = self.inner.diagrams.child.lock().expect("child").as_mut().and_then(|child| child.try_wait().ok()).flatten().is_some();
            if finished { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        let svg = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
        let _ = self.inner.diagrams.child.lock().expect("child").take();
        if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
            return Err(translate(language, "图表渲染已取消", &[] as &[String]));
        }
        if !svg.contains("<svg") { return Err(translate(language, "图表渲染未返回 SVG", &[] as &[String])); }
        Ok(svg)
    }

    /// Hidden Chrome process. The page loads mermaid with `securityLevel: 'strict'`
    /// and has no Node and no workbench preload. Chrome's own sandbox cannot start
    /// in this container, so the process uses a private profile and a cleared environment.
    fn render_browser(&self, source: &str, generation: u64, language: &str) -> Result<String, String> {
        let browser = browser_bin().ok_or_else(|| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let library = mermaid_library().ok_or_else(|| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let root = std::env::temp_dir().join(format!("pello-diagram-{}", random_id()));
        fs::create_dir_all(root.join("profile")).map_err(|error| error.to_string())?;
        std::os::unix::fs::symlink(&library, root.join("mermaid.min.js")).map_err(|error| error.to_string())?;
        let html = format!(
            "<!DOCTYPE html><meta charset=\"utf-8\"><body><script src=\"mermaid.min.js\"></script><script>\nconst source = {};\nmermaid.initialize({{ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true, maxTextSize: 100000 }});\nmermaid.render('pelloDiagram', source).then((result) => {{ document.documentElement.setAttribute('data-pello-ready', '1'); document.body.innerHTML = result.svg; }}).catch((error) => {{ document.documentElement.setAttribute('data-pello-error', '1'); document.body.textContent = String(error && error.message || error); }});\n</script></body>",
            serde_json::to_string(source).unwrap_or_else(|_| "\"\"".into())
        );
        fs::write(root.join("render.html"), html).map_err(|error| error.to_string())?;
        let mut command = Command::new(&browser);
        command.env_clear();
        if let Some(path) = std::env::var_os("PATH") { command.env("PATH", path); }
        command.env("HOME", &root);
        command.env("TMPDIR", &root);
        command.env("XDG_CONFIG_HOME", root.join("profile"));
        command.env("XDG_CACHE_HOME", root.join("profile"));
        command.args([
            "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
            "--disable-extensions", "--disable-background-networking", "--disable-sync", "--disable-default-apps",
        ]);
        command.arg(format!("--user-data-dir={}", root.join("profile").display()));
        command.args(["--virtual-time-budget=8000", "--dump-dom"]);
        command.arg(format!("file://{}", root.join("render.html").display()));
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        if let Ok(log) = std::env::var("AWB_DIAGRAM_LOG") {
            let args = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\n");
            let _ = fs::write(log, format!("argv0={}\n{args}\n", browser.display()));
        }
        let mut child = command.spawn().map_err(|_| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let mut stdout = child.stdout.take().ok_or_else(|| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let buffer = Arc::new(Mutex::new(String::new()));
        let collect = buffer.clone();
        let reader = std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => collect.lock().expect("diagram").push_str(&String::from_utf8_lossy(&chunk[..size])),
                }
            }
        });
        {
            let mut slot = self.inner.diagrams.child.lock().expect("child");
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                stop_child(&mut child);
                drop(slot);
                let _ = reader.join();
                let _ = fs::remove_dir_all(&root);
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            *slot = Some(child);
        }
        let started = Instant::now();
        let svg = loop {
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                self.stop_diagram();
                let _ = reader.join();
                let _ = fs::remove_dir_all(&root);
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            if started.elapsed() > Duration::from_secs(15) {
                self.stop_diagram();
                let _ = reader.join();
                let _ = fs::remove_dir_all(&root);
                return Err(translate(language, "图表渲染超时，请简化图表后重试", &[] as &[String]));
            }
            let current = buffer.lock().expect("diagram").clone();
            if let Some(svg) = extract_svg(&current) {
                self.stop_diagram();
                break svg;
            }
            if current.contains("data-pello-error") && current.contains("</html>") {
                self.stop_diagram();
                let _ = reader.join();
                let _ = fs::remove_dir_all(&root);
                return Err(translate(language, "图表渲染未返回 SVG", &[] as &[String]));
            }
            let finished = self.inner.diagrams.child.lock().expect("child").as_mut().and_then(|child| child.try_wait().ok()).flatten().is_some();
            if finished && extract_svg(&buffer.lock().expect("diagram")).is_none() {
                let _ = reader.join();
                let _ = fs::remove_dir_all(&root);
                return Err(translate(language, "图表渲染未返回 SVG", &[] as &[String]));
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = reader.join();
        let _ = self.inner.diagrams.child.lock().expect("child").take();
        let _ = fs::remove_dir_all(&root);
        if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
            return Err(translate(language, "图表渲染已取消", &[] as &[String]));
        }
        Ok(svg)
    }

    pub fn cancel(&self) {
        self.inner.diagrams.generation.fetch_add(1, Ordering::SeqCst);
        self.stop_diagram();
    }

    fn stop_diagram(&self) {
        if let Some(child) = self.inner.diagrams.child.lock().expect("child").as_mut() { stop_child(child); }
    }

    fn ensure(&self, language: &str) -> Result<u16, String> {
        let mut port = self.inner.port.lock().expect("port");
        if let Some(port) = *port { return Ok(port); }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| translate(language, "无法启动预览", &[] as &[String]))?;
        listener.set_nonblocking(true).map_err(|error| error.to_string())?;
        let number = listener.local_addr().map_err(|error| error.to_string())?.port();
        *port = Some(number);
        drop(port);
        let inner = self.inner.clone();
        std::thread::spawn(move || serve(listener, inner));
        Ok(number)
    }
}

impl Drop for Service {
    fn drop(&mut self) { self.inner.alive.store(false, Ordering::SeqCst); self.cancel(); }
}

fn browser_bin() -> Option<PathBuf> {
    for candidate in ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] {
        let path = PathBuf::from(candidate);
        if path.is_file() { return Some(path); }
    }
    None
}

fn mermaid_library() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AWB_MERMAID_JS") {
        let path = PathBuf::from(path);
        if path.is_file() { return Some(path); }
    }
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/mermaid/dist/mermaid.min.js");
    if compiled.is_file() { Some(compiled) } else { None }
}

fn extract_svg(document: &str) -> Option<String> {
    let start = document.find("<svg")?;
    let end = document[start..].find("</svg>")?;
    Some(document[start..start + end + "</svg>".len()].to_string())
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
}

fn serve(listener: TcpListener, inner: Arc<Inner>) {
    while inner.alive.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => { let inner = inner.clone(); std::thread::spawn(move || respond(stream, &inner)); }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }
}

fn respond(mut stream: TcpStream, inner: &Inner) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut header = Vec::new();
    let mut buf = [0u8; 1024];
    while !header.windows(4).any(|item| item == b"\r\n\r\n") && header.len() < 8192 {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(count) => header.extend_from_slice(&buf[..count]),
        }
    }
    let text = String::from_utf8_lossy(&header);
    let Some(line) = text.lines().next() else { return };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        let _ = write_response(&mut stream, 405, "text/plain; charset=utf-8", b"method", &[], false);
        return;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut segments = path.trim_start_matches('/').split('/').filter(|part| !part.is_empty()).map(decode_component);
    let Some(token) = segments.next() else { let _ = write_response(&mut stream, 404, "text/plain; charset=utf-8", b"missing", &[], false); return };
    let relative = segments.collect::<Vec<_>>().join("/");
    let projects = inner.projects.lock().expect("preview");
    let Some(project) = projects.values().find(|project| project.token == token) else {
        drop(projects);
        let _ = write_response(&mut stream, 404, "text/plain; charset=utf-8", "missing".as_bytes(), &[], false);
        return;
    };
    let language = project.language.clone();
    let root = project.root.clone();
    let draft = query_value(query, "draft").and_then(|token| project.drafts.get(&relative).filter(|draft| draft.token == token).map(|draft| draft.text.clone()));
    drop(projects);
    let bytes = if let Some(draft) = draft { draft.into_bytes() } else {
        match read_asset(&root, &relative, &language) {
            Ok(bytes) => bytes,
            Err(_) => {
                let message = translate(&language, "资源不存在或不可访问", &[] as &[String]);
                let _ = write_response(&mut stream, 404, "text/plain; charset=utf-8", message.as_bytes(), &[], method == "HEAD");
                return;
            }
        }
    };
    let mut body = bytes;
    if is_html(&relative) && query_value(query, "workbenchWheel").as_deref() == Some("1") {
        let html = String::from_utf8_lossy(&body).into_owned();
        let lower = html.to_ascii_lowercase();
        let offset = lower.find("<head").and_then(|start| html[start..].find('>').map(|end| start + end + 1)).unwrap_or(0);
        body = format!("{}{BRIDGE}{}", &html[..offset], &html[offset..]).into_bytes();
    }
    let mime = mime_of(&relative);
    let _ = write_response(&mut stream, 200, mime, &body, &[("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store")], method == "HEAD");
}

fn write_response(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8], extra: &[(&str, &str)], head: bool) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else if status == 405 { "Method Not Allowed" } else { "Not Found" };
    let mut head_text = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (name, value) in extra { head_text.push_str(&format!("{name}: {value}\r\n")); }
    head_text.push_str("\r\n");
    stream.write_all(head_text.as_bytes())?;
    if !head { stream.write_all(body)?; }
    Ok(())
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key { Some(decode_component(value)) } else { None }
    })
}

pub fn read_asset(root: &Path, rel: &str, language: &str) -> Result<Vec<u8>, String> {
    let relative = normalize_rel(rel, language)?;
    let root = fs::canonicalize(root).map_err(|_| translate(language, "目录不存在", &[] as &[String]))?;
    let mut walk = root.clone();
    for part in relative.split('/') {
        walk.push(part);
        let meta = fs::symlink_metadata(&walk).map_err(|_| translate(language, "资源不存在或不可访问", &[] as &[String]))?;
        if meta.file_type().is_symlink() { return Err(translate(language, "符号链接不可预览", &[] as &[String])); }
        if !walk.starts_with(&root) { return Err(translate(language, "路径超出项目目录", &[] as &[String])); }
    }
    let meta = fs::metadata(&walk).map_err(|_| translate(language, "资源不存在或不可访问", &[] as &[String]))?;
    if !meta.is_file() { return Err(translate(language, "资源不存在或不可访问", &[] as &[String])); }
    if meta.len() > PREVIEW_LIMIT { return Err(translate(language, "预览资源超过 12 MB", &[] as &[String])); }
    fs::read(&walk).map_err(|_| translate(language, "资源不存在或不可访问", &[] as &[String]))
}

fn normalize_rel(rel: &str, language: &str) -> Result<String, String> {
    let relative = clean_relative(rel, language)?;
    if relative.is_empty() { return Err(translate(language, "文件路径不能为空", &[] as &[String])); }
    Ok(relative)
}

fn is_html(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

fn mime_of(rel: &str) -> &'static str {
    match Path::new(rel).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { out.push(byte as char); }
        else { out.push_str(&format!("%{byte:02X}")); }
    }
    out
}

fn decode_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) { out.push(byte); index += 3; continue; }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[allow(dead_code)]
pub fn wheel_value(state: WheelState) -> serde_json::Value {
    json!({ "page": state.page, "zoom": state.zoom })
}
