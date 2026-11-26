//! Read-only project previews. HTML is served from a loopback socket.
//! Mermaid is rendered by a separate sandbox process with no workbench API and no Node permission.

use crate::files::clean_relative;
use crate::i18n::translate;
use crate::random_id;
use crate::ssh;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use crate::sys::Helper;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PREVIEW_LIMIT: u64 = 12_000_000;
/// A previewed draft is a document, and may be as large as one.
const DRAFT_LIMIT: usize = crate::files::DOCUMENT_LIMIT as usize;

/// Same behavior as `htmlPreviewBridge` in `src/shared/preview-bridge.ts`.
/// `awb-eval` exists because WebKitGTK's remote inspector does not evaluate a
/// sandboxed opaque iframe. Only the embedding page can send it.
const BRIDGE: &str = r#"<script>(function(){
const send=(data)=>parent.postMessage(data,'*');
send({type:'awb-eval-ready',src:location.href});
let searchOpen=false;
addEventListener('wheel',(event)=>{
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.deltaY){event.preventDefault();event.stopPropagation();send({type:'pello-preview-zoom',deltaY:event.deltaY});}
},{passive:false,capture:true});
addEventListener('contextmenu',(event)=>{event.preventDefault();send({type:'pello-preview-context'});},true);
addEventListener('keydown',(event)=>{
  if(event.isComposing)return;
  const key=event.key.toLowerCase();
  if(((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&(key==='f'||key==='h'))||(searchOpen&&(event.key==='F3'||event.key==='Escape'))){
    event.preventDefault();event.stopPropagation();send({type:'pello-preview-key',key,shift:event.shiftKey});
  }
},true);
let text='',nodes=[],starts=[];
const collect=()=>{
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let node,value='';
  nodes=[];starts=[];
  while((node=walker.nextNode())){
    const element=node.parentElement;
    if(!element||element.closest('script,style,noscript,[hidden],[aria-hidden=true]')||!element.getClientRects().length||getComputedStyle(element).visibility==='hidden')continue;
    starts.push(value.length);nodes.push(node);value+=node.textContent||'';
  }
  if(text!==value){text=value;send({type:'pello-preview-text',text});}
};
addEventListener('message',(event)=>{
  if(event.source!==parent||!event.data)return;
  if(event.data.type==='awb-eval-ping'){send({type:'awb-eval-ready',id:event.data.id});return;}
  if(event.data.type==='awb-eval'){
    const id=event.data.id;
    try{(0,eval)(event.data.source);}catch(error){send({type:'awb-eval-result',id,ok:false,error:String(error&&error.message||error)});}
    return;
  }
  if(event.data.type!=='pello-preview-search')return;
  searchOpen=!!event.data.open;
  collect();
  const ranges=[];
  const range=(from,to)=>{
    let a=0,b=0;
    while(a<nodes.length-1&&starts[a+1]<=from)a++;
    while(b<nodes.length-1&&starts[b]+nodes[b].length<to)b++;
    if(!nodes[a]||!nodes[b]||from<0||to>text.length)return null;
    const result=document.createRange();
    result.setStart(nodes[a],from-starts[a]);result.setEnd(nodes[b],to-starts[b]);return result;
  };
  const matches=Array.isArray(event.data.matches)?event.data.matches:[];
  for(const match of matches.slice(0,2000)){const item=range(match.from,match.to);if(item)ranges.push(item);}
  const current=event.data.current?range(event.data.current.from,event.data.current.to):null;
  CSS.highlights.set('document-matches',new Highlight(...ranges));
  CSS.highlights.set('document-current',new Highlight(...(current?[current]:[])));
  if(current){const box=current.getBoundingClientRect();if(box.top<24||box.bottom>innerHeight-24)scrollBy(0,box.top-innerHeight/3);}
});
addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');
  style.textContent='::highlight(document-matches){background:#fff0a6;color:#211d00}::highlight(document-current){background:#d6bbff;color:#201138}';
  document.head.append(style);
  collect();
  let timer;
  new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(collect,100);}).observe(document.body,{childList:true,characterData:true,subtree:true});
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

#[derive(Clone)]
enum Source {
    Local(PathBuf),
    Remote { data: PathBuf, host: Value, root: String },
}

struct Project { token: String, source: Source, drafts: HashMap<String, Draft>, language: String }

struct Diagrams {
    generation: AtomicU64,
    child: Mutex<Option<Helper>>,
    gate: Mutex<()>,
    /// Runs one diagram in strict mode and returns its SVG. The shell sets it.
    renderer: Mutex<Option<Renderer>>,
    cache: Mutex<Vec<(String, String)>>,
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
            diagrams: Diagrams { generation: AtomicU64::new(0), child: Mutex::new(None), gate: Mutex::new(()), renderer: Mutex::new(None), cache: Mutex::new(Vec::new()) },
        }) }
    }

    pub fn url(&self, project_id: &str, root: &Path, rel: &str, draft: Option<&str>, language: &str) -> Result<String, String> {
        let relative = normalize_rel(rel, language)?;
        let _ = read_asset(root, &relative, language)?;
        if let Some(draft) = draft {
            if !is_html(&relative) || draft.len() > DRAFT_LIMIT { return Err(translate(language, "预览草稿必须为 10 MB 以内的 HTML", &[] as &[String])); }
        }
        self.publish(project_id, &format!("{project_id}:{}", root.display()), Source::Local(root.to_path_buf()), &relative, draft, language)
    }

    /// Remote HTML and assets are read over SSH into the same loopback server. The draft stays in memory.
    pub fn url_remote(&self, project_id: &str, data: &Path, host: &Value, root: &str, rel: &str, draft: Option<&str>, language: &str) -> Result<String, String> {
        let relative = normalize_rel(rel, language)?;
        let _ = read_remote_asset(data, host, root, &relative, language)?;
        if let Some(draft) = draft {
            if !is_html(&relative) || draft.len() > DRAFT_LIMIT { return Err(translate(language, "预览草稿必须为 10 MB 以内的 HTML", &[] as &[String])); }
        }
        let source = Source::Remote { data: data.to_path_buf(), host: host.clone(), root: root.to_string() };
        let identity = format!("{project_id}:{}:{root}", host["id"].as_str().unwrap_or(""));
        self.publish(project_id, &identity, source, &relative, draft, language)
    }

    fn publish(&self, _project_id: &str, identity: &str, source: Source, relative: &str, draft: Option<&str>, language: &str) -> Result<String, String> {
        let port = self.ensure(language)?;
        let mut projects = self.inner.projects.lock().expect("preview");
        let entry = projects.entry(identity.to_string()).or_insert_with(|| Project { token: random_id(), source: source.clone(), drafts: HashMap::new(), language: language.to_string() });
        entry.language = language.to_string();
        entry.source = source;
        let mut query = String::new();
        if let Some(draft) = draft {
            let token = random_id();
            entry.drafts.insert(relative.to_string(), Draft { token: token.clone(), text: draft.to_string() });
            query = format!("?draft={token}");
        }
        let encoded = relative.split('/').map(encode_component).collect::<Vec<_>>().join("/");
        Ok(format!("http://127.0.0.1:{port}/{}/{}{query}", entry.token, encoded))
    }

    pub fn render_mermaid(&self, source: &str, language: &str) -> Result<String, String> {
        if source.trim().is_empty() || source.chars().count() > 100_000 {
            return Err(translate(language, "Mermaid 内容为空或超过 100000 字符", &[] as &[String]));
        }
        if let Some(svg) = self.cached_diagram(source) { return Ok(svg); }
        let _gate = self.inner.diagrams.gate.lock().expect("diagram");
        if let Some(svg) = self.cached_diagram(source) { return Ok(svg); }
        let generation = self.inner.diagrams.generation.load(Ordering::SeqCst);
        if generation != self.inner.diagrams.generation.load(Ordering::SeqCst) {
            return Err(translate(language, "图表渲染已取消", &[] as &[String]));
        }
        let svg = if let Some(bin) = std::env::var("AWB_DIAGRAM_BIN").ok().filter(|value| !value.is_empty()) {
            self.render_external(&bin, source, generation, language)?
        } else {
            let renderer = self.inner.diagrams.renderer.lock().expect("diagram renderer").clone();
            let Some(render) = renderer else {
                return Err(translate(language, "图表渲染器不可用", &[] as &[String]));
            };
            let outcome = render.render(source, generation);
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            outcome?
        };
        self.store_diagram(source, &svg);
        Ok(svg)
    }

    fn cached_diagram(&self, source: &str) -> Option<String> {
        let mut cache = self.inner.diagrams.cache.lock().expect("diagram cache");
        let index = cache.iter().position(|(key, _)| key == source)?;
        let item = cache.remove(index);
        let svg = item.1.clone();
        cache.push(item);
        Some(svg)
    }

    fn store_diagram(&self, source: &str, svg: &str) {
        if svg.len() * 2 > 8_000_000 { return }
        let mut cache = self.inner.diagrams.cache.lock().expect("diagram cache");
        cache.retain(|(key, _)| key != source);
        cache.push((source.to_string(), svg.to_string()));
        while cache.len() > 32 || cache.iter().map(|(_, item)| item.len() * 2).sum::<usize>() > 8_000_000 {
            cache.remove(0);
        }
    }

    fn render_external(&self, bin: &str, source: &str, generation: u64, language: &str) -> Result<String, String> {
        let mut command = Command::new(bin);
        command.env_clear();
        if let Some(path) = std::env::var_os("PATH") { command.env("PATH", path); }
        command.args(["--security-level", "strict", "--sandbox", "--no-node", "--no-workbench"]);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut helper = Helper::spawn(&mut command).map_err(|_| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let mut stdout = helper.child.stdout.take().ok_or_else(|| translate(language, "图表渲染器不可用", &[] as &[String]))?;
        let reader = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = stdout.read_to_end(&mut buf); buf });
        if let Some(mut stdin) = helper.child.stdin.take() { let _ = stdin.write_all(source.as_bytes()); }
        {
            let mut slot = self.inner.diagrams.child.lock().expect("child");
            if self.inner.diagrams.generation.load(Ordering::SeqCst) != generation {
                helper.stop();
                drop(slot);
                let _ = reader.join();
                return Err(translate(language, "图表渲染已取消", &[] as &[String]));
            }
            *slot = Some(helper);
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
            let finished = self.inner.diagrams.child.lock().expect("child").as_mut().is_some_and(Helper::done);
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

    pub fn cancel(&self) {
        self.inner.diagrams.generation.fetch_add(1, Ordering::SeqCst);
        self.stop_diagram();
        self.reset_renderer();
    }


    fn stop_diagram(&self) {
        if let Some(helper) = self.inner.diagrams.child.lock().expect("child").as_mut() { helper.stop(); }
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

/// Renders one diagram in Mermaid's strict mode and blocks until the SVG is
/// ready. `generation` is the cancel counter of the service.
pub trait DiagramRenderer: Send + Sync {
    fn render(&self, source: &str, generation: u64) -> Result<String, String>;
    /// Stop the render in progress and drop what it used, as a window.
    fn reset(&self);
}

pub type Renderer = Arc<dyn DiagramRenderer>;

impl Service {
    /// The shell installs its renderer here once its window can render.
    pub fn set_renderer(&self, renderer: Renderer) {
        *self.inner.diagrams.renderer.lock().expect("diagram renderer") = Some(renderer);
    }

    /// The render in progress is abandoned; a slow or broken window is not
    /// reused for the next diagram.
    fn reset_renderer(&self) {
        if let Some(renderer) = self.inner.diagrams.renderer.lock().expect("diagram renderer").as_ref() {
            renderer.reset();
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) { self.inner.alive.store(false, Ordering::SeqCst); self.cancel(); }
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
    let source = project.source.clone();
    let draft = query_value(query, "draft").and_then(|token| project.drafts.get(&relative).filter(|draft| draft.token == token).map(|draft| draft.text.clone()));
    drop(projects);
    let bytes = if let Some(draft) = draft { draft.into_bytes() } else {
        match read_source(&source, &relative, &language) {
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
    let origin = header_value(&text, "origin");
    let mut extra = vec![
        ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
        ("Referrer-Policy".to_string(), "no-referrer".to_string()),
        ("Cache-Control".to_string(), "no-store".to_string()),
    ];
    // Opaque sandbox documents and the workbench page may read project assets.
    // Any other website is refused, matching the Electron preview server.
    if let Some(origin) = origin.filter(|value| value == "null" || workbench_origin(value)) {
        extra.push(("Access-Control-Allow-Origin".to_string(), origin));
        extra.push(("Vary".to_string(), "Origin".to_string()));
        extra.push(("Access-Control-Expose-Headers".to_string(), "Accept-Ranges, Content-Encoding, Content-Length, Content-Range".to_string()));
    }
    let extra_refs: Vec<(&str, &str)> = extra.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
    let _ = write_response(&mut stream, 200, mime, &body, &extra_refs, method == "HEAD");
}

fn header_value(text: &str, name: &str) -> Option<String> {
    text.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.eq_ignore_ascii_case(name) { Some(value.trim().to_string()) } else { None }
    })
}

fn workbench_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else { return false };
    let host = rest.split([':', '/']).next().unwrap_or("");
    host == "127.0.0.1" || host == "localhost" || host == "tauri.localhost"
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

fn read_source(source: &Source, relative: &str, language: &str) -> Result<Vec<u8>, String> {
    match source {
        Source::Local(root) => read_asset(root, relative, language),
        Source::Remote { data, host, root } => read_remote_asset(data, host, root, relative, language),
    }
}

fn read_remote_asset(data: &Path, host: &Value, root: &str, relative: &str, language: &str) -> Result<Vec<u8>, String> {
    let script = if host["platform"] == "windows" {
        let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
        let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw 'AWB_LINK' }}", ssh::ps_quote(part))).collect::<Vec<_>>().join("; ");
        format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath((Join-Path $root {})); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {{ throw 'AWB_OUT' }}; $walk=$root.TrimEnd('\\'); {walk}; $len=(Get-Item -LiteralPath $file).Length; if ($len -gt 12000000) {{ throw 'AWB_BIG' }}; [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))", ssh::ps_quote(root), ssh::ps_quote(&relative.replace('/', "\\")))
    } else {
        let file = format!("{}/{}", root.trim_end_matches('/'), relative);
        format!(r#"root=$(cd -P -- {root_q} && pwd) || exit 1
file={file_q}
if [ -L "$file" ]; then printf 'AWB_LINK\n' >&2; exit 1; fi
parent=$(cd -P -- "$(dirname -- "$file")" && pwd) || exit 1
root=${{root%/}}
case "$parent/" in
  "$root/"*) ;;
  *) printf 'AWB_OUT\n' >&2; exit 1 ;;
esac
size=$(wc -c < "$file") || exit 1
if [ "$size" -gt 12000000 ]; then printf 'AWB_BIG\n' >&2; exit 1; fi
base64 -w 0 "$file" 2>/dev/null || base64 "$file""#, root_q = ssh::bash_quote(root), file_q = ssh::bash_quote(&file))
    };
    let text = ssh::run(data, host, &script, None, language).map_err(|error| remote_asset_error(&error, language))?;
    let compact: String = text.chars().filter(|char| !char.is_whitespace()).collect();
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, compact).map_err(|_| translate(language, "资源不存在或不可访问", &[] as &[String]))?;
    if bytes.len() as u64 > PREVIEW_LIMIT { return Err(translate(language, "预览资源超过 12 MB", &[] as &[String])) }
    Ok(bytes)
}

fn remote_asset_error(error: &str, language: &str) -> String {
    if error.contains("AWB_LINK") { return translate(language, "符号链接不可预览", &[] as &[String]) }
    if error.contains("AWB_BIG") { return translate(language, "预览资源超过 12 MB", &[] as &[String]) }
    translate(language, "资源不存在或不可访问", &[] as &[String])
}

pub fn read_asset(root: &Path, rel: &str, language: &str) -> Result<Vec<u8>, String> {
    let relative = normalize_rel(rel, language)?;
    let root = crate::real_path(root).map_err(|_| translate(language, "目录不存在", &[] as &[String]))?;
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
