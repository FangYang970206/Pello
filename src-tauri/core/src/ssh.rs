//! SSH transport for password and key authentication.
//! Passwords stay in the main process. The renderer only sees `hasPassword`.
//! Password sessions pin the first host key, matching `src/main/ssh.ts`.

use crate::i18n::translate;
use crate::shells::BASH_RC;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use std::borrow::Cow;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Server as _};
use russh::{ChannelId, ChannelMsg, CryptoVec, Disconnect};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Base64 of a 12 MB preview is 16 MB. The cap stays above that so a legal asset is not rejected as oversized output.
const MAX_OUTPUT: usize = 16_000_100;

/// What every Windows remote script starts with: the standard input and
/// output of the PowerShell that runs it are UTF-8. Error handling is left to
/// the script.
const POWERSHELL_UTF8: &str = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ";

pub fn bash_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A local path handed to a POSIX shell. Windows Bash takes forward slashes,
/// which also keep a path from mixing separators once quoted.
pub fn bash_path_quote(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    bash_quote(&if cfg!(windows) { text.replace('\\', "/") } else { text })
}

pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn remote_command(platform: &str, args: &[String]) -> String {
    if platform != "windows" {
        return args.iter().map(|arg| bash_quote(arg)).collect::<Vec<_>>().join(" ");
    }
    if args.first().map(|arg| arg == "powershell.exe").unwrap_or(false) {
        if let Some(index) = args.iter().position(|arg| arg == "-Command") {
            if index + 1 < args.len() {
                // The script travels as UTF-16, but what the workbench writes
                // to the remote's standard input and reads back is UTF-8. A
                // Windows PowerShell decodes both by the system code page
                // unless told otherwise, which breaks a translated message or
                // a path outside that code page.
                let script = format!("{POWERSHELL_UTF8}{}", args[index + 1]);
                let encoded = encode_utf16_le_base64(&script);
                return format!("{} -EncodedCommand {encoded}", args[..index].join(" "));
            }
        }
    }
    args.iter().map(|arg| if arg.chars().any(|char| char.is_whitespace() || char == '"') { format!("\"{}\"", arg.replace('"', "\\\"")) } else { arg.clone() }).collect::<Vec<_>>().join(" ")
}

fn encode_utf16_le_base64(text: &str) -> String {
    let mut bytes = Vec::new();
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode_powershell_command(command: &str) -> Option<String> {
    let encoded = command.split_whitespace().skip_while(|part| *part != "-EncodedCommand").nth(1)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    if bytes.len() % 2 != 0 { return None }
    let units: Vec<u16> = bytes.chunks_exact(2).map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect();
    String::from_utf16(&units).ok()
}

pub fn remote_bootstrap(cwd: &str) -> String {
    format!("export AWB_CWD={}; exec bash --noprofile --rcfile <(cat << 'AWB_RC'\n{BASH_RC}\nAWB_RC\n) -i", bash_quote(cwd))
}

fn identity(addr: &str, port: u16, user: &str) -> String {
    format!("[\"{addr}\",{port},\"{user}\"]")
}

fn key_identity(addr: &str, port: u16) -> String {
    format!("[\"{addr}\",{port}]")
}

fn host_port(host: &Value) -> u16 {
    host["port"].as_u64().filter(|port| *port > 0 && *port <= 65535).unwrap_or(22) as u16
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("ssh runtime"))
}

struct Secrets {
    memory: HashMap<String, String>,
    key: [u8; 32],
}

fn secrets(data: &Path) -> Arc<Mutex<Secrets>> {
    static SECRETS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Secrets>>>>> = OnceLock::new();
    let map = SECRETS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = map.lock().expect("secrets");
    map.entry(data.to_path_buf()).or_insert_with(|| Arc::new(Mutex::new(load_secrets(data)))).clone()
}

fn load_secrets(data: &Path) -> Secrets {
    let key_path = data.join("credentials.key");
    let key = fs::read(&key_path).ok().filter(|bytes| bytes.len() == 32).map(|bytes| {
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        key
    }).unwrap_or_else(|| {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).expect("credential key");
        let _ = crate::sys::private_file(&key_path).and_then(|mut file| file.write_all(&key));
        key
    });
    Secrets { memory: HashMap::new(), key }
}

fn credential_file(data: &Path) -> PathBuf { data.join("credentials.json") }
fn fingerprint_file(data: &Path) -> PathBuf { data.join("ssh-host-keys.json") }

fn read_json(path: &Path) -> Value {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({}))
}

fn write_private(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let temporary = path.with_extension("json.tmp");
    let mut file = crate::sys::private_file(&temporary).map_err(|error| error.to_string())?;
    file.write_all(serde_json::to_string(value).unwrap_or_else(|_| "{}".into()).as_bytes()).map_err(|error| error.to_string())?;
    // Close before the rename: Windows keeps a written file in place while a
    // handle to it is open, and the write is complete at this point.
    drop(file);
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn seal(key: &[u8; 32], password: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|error| error.to_string())?;
    let cipher_text = cipher.encrypt(Nonce::from_slice(&nonce_bytes), password.as_bytes()).map_err(|_| "encrypt".to_string())?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend(cipher_text);
    Ok(base64::engine::general_purpose::STANDARD.encode(blob))
}

fn open_secret(key: &[u8; 32], stored: &str) -> Option<String> {
    let blob = base64::engine::general_purpose::STANDARD.decode(stored).ok()?;
    if blob.len() < 13 { return None }
    let cipher = Aes256Gcm::new(key.into());
    let plain = cipher.decrypt(Nonce::from_slice(&blob[..12]), &blob[12..]).ok()?;
    String::from_utf8(plain).ok()
}

pub fn remember_password(data: &Path, host: &Value) {
    if host["auth"] != "password" || host.get("password").is_none() { return }
    let key = identity(host["addr"].as_str().unwrap_or(""), host_port(host), host["user"].as_str().unwrap_or(""));
    let secrets = secrets(data);
    let mut secrets = secrets.lock().expect("secrets");
    let mut records = read_json(&credential_file(data));
    if !records.is_object() { records = json!({}); }
    match host["password"].as_str() {
        Some(password) if !password.is_empty() => {
            secrets.memory.insert(key.clone(), password.to_string());
            if let Ok(stored) = seal(&secrets.key, password) {
                records[&key] = json!(stored);
            }
        }
        _ => {
            secrets.memory.remove(&key);
            if let Some(object) = records.as_object_mut() { object.remove(&key); }
        }
    }
    let _ = write_private(&credential_file(data), &records);
}

pub fn password_of(data: &Path, host: &Value) -> Option<String> {
    if let Some(password) = host["password"].as_str() {
        if !password.is_empty() { return Some(password.to_string()) }
    }
    let key = identity(host["addr"].as_str().unwrap_or(""), host_port(host), host["user"].as_str().unwrap_or(""));
    let secrets = secrets(data);
    let secrets = secrets.lock().expect("secrets");
    if let Some(password) = secrets.memory.get(&key) { return Some(password.clone()) }
    let stored = read_json(&credential_file(data));
    stored[&key].as_str().and_then(|text| open_secret(&secrets.key, text))
}

pub fn has_password(data: &Path, host: &Value) -> bool {
    let mut clean = host.clone();
    if let Some(object) = clean.as_object_mut() { object.remove("password"); }
    password_of(data, &clean).is_some()
}

pub fn run(data: &Path, host: &Value, script: &str, input: Option<&[u8]>, language: &str) -> Result<String, String> {
    let platform = host["platform"].as_str().unwrap_or("linux");
    let command = if platform == "windows" {
        remote_command("windows", &[String::from("powershell.exe"), String::from("-NoProfile"), String::from("-Command"), script.to_string()])
    } else {
        remote_command("linux", &[String::from("bash"), String::from("-lc"), script.to_string()])
    };
    exec_command(data, host, &command, input, language)
}

/// Remote delete script. Only the fixed error strings are translated and quoted.
/// Cmdlets, `rm`, and the caller's path stay as written.
pub fn remove_remote_script(platform: &str, root: &str, relative: &str, directory: bool, language: &str) -> Result<String, String> {
    let relative = crate::files::clean_relative(relative, language)?;
    if relative.is_empty() { return Err(translate(language, "不能删除项目根目录", &[] as &[String])) }
    let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    if platform == "windows" {
        if parts.iter().any(|part| part.contains(':')) { return Err(translate(language, "非法文件路径", &[] as &[String])) }
        let link = ps_quote(&translate(language, "不支持删除符号链接", &[] as &[String]));
        let changed = ps_quote(&translate(language, "文件类型已更改", &[] as &[String]));
        let nested = ps_quote(&translate(language, "目录包含符号链接", &[] as &[String]));
        let walk = parts.iter().map(|part| {
            format!("$walk=Join-Path $walk {}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}", ps_quote(part))
        }).collect::<Vec<_>>().join("; ");
        let action = if directory {
            format!("Get-ChildItem -LiteralPath $walk -Force -Recurse | ForEach-Object {{ if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {nested} }} }}; Remove-Item -LiteralPath $walk -Recurse -Force -ErrorAction Stop")
        } else {
            "Remove-Item -LiteralPath $walk -Force -ErrorAction Stop".to_string()
        };
        let flag = if directory { "true" } else { "false" };
        return Ok(format!("$ErrorActionPreference='Stop'; $walk=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path; {walk}; if ($item.PSIsContainer -ne ${flag}) {{ throw {changed} }}; {action}", ps_quote(root)));
    }
    let link = bash_quote(&translate(language, "不支持删除符号链接", &[] as &[String]));
    let changed = bash_quote(&translate(language, "文件类型已更改", &[] as &[String]));
    let walk = parts.iter().map(|part| format!("p=\"$p\"/{}; [ ! -L \"$p\" ] || {{ echo {link} >&2; exit 1; }}", bash_quote(part))).collect::<Vec<_>>().join("; ");
    let kind = if directory { "[ -d \"$p\" ]" } else { "[ -f \"$p\" ]" };
    let remove = if directory { "rm -rf -- \"$p\"" } else { "rm -f -- \"$p\"" };
    Ok(format!("p=$(cd -P -- {} && pwd) || exit 1; {walk}; {kind} || {{ echo {changed} >&2; exit 1; }}; {remove}", bash_quote(root)))
}

fn ps_error(language: &str, source: &str) -> String {
    ps_quote(&translate(language, source, &[] as &[String]))
}

/// Windows remote scripts. Only the fixed error text is translated and quoted.
pub fn windows_create_script(root: &str, parent_abs: &str, dest_abs: &str, directory: bool, language: &str) -> String {
    let illegal = ps_error(language, "非法路径");
    let link = ps_error(language, "不支持链接目录");
    let make = if directory {
        "New-Item -ItemType Directory -Path $dest -ErrorAction Stop | Out-Null"
    } else {
        "$f=[IO.File]::Open($dest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $f.Dispose()"
    };
    format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path.TrimEnd('\\'); $parent=[IO.Path]::GetFullPath({}).TrimEnd('\\'); if ($parent -ne $root -and -not $parent.StartsWith($root+'\\',[StringComparison]::OrdinalIgnoreCase)) {{ throw {illegal} }}; $walk=$root; if ($parent -ne $root) {{ foreach ($part in $parent.Substring($root.Length+1).Split('\\')) {{ $walk=Join-Path $walk $part; if ((Get-Item -LiteralPath $walk -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }} }} }}; $dest={}; {make}", ps_quote(root), ps_quote(parent_abs), ps_quote(dest_abs))
}

pub fn windows_rename_script(root: &str, relative: &str, name: &str, destination_parent: &str, directory: bool, language: &str) -> Result<String, String> {
    let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() { return Err(translate(language, "不能重命名项目根目录", &[] as &[String])); }
    let link = ps_error(language, "不支持通过符号链接重命名");
    let changed = ps_error(language, "文件类型已更改");
    let unsafe_dir = ps_error(language, "目标不是安全目录");
    let kept = ps_error(language, "重命名失败，原对象保留于 ");
    let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}", ps_quote(part))).collect::<Vec<_>>().join("; ");
    let target_walk = destination_parent.split('/').filter(|part| !part.is_empty()).map(|part| format!("$parent=Join-Path $parent {}; $parentItem=Get-Item -LiteralPath $parent -Force -ErrorAction Stop; if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $parentItem.PSIsContainer) {{ throw {unsafe_dir} }}", ps_quote(part))).collect::<Vec<_>>().join("; ");
    let flag = if directory { "true" } else { "false" };
    let move_cmd = if directory { "[IO.Directory]::Move" } else { "[IO.File]::Move" };
    let temporary = format!(".awb-rename-{}", crate::random_id());
    let target_stmt = if target_walk.is_empty() { String::new() } else { format!("{target_walk}; ") };
    Ok(format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path; $walk=$root; {walk}; if ($item.PSIsContainer -ne ${flag}) {{ throw {changed} }}; $parent=$root; {target_stmt}$dest=Join-Path $parent {}; if ([String]::Equals($walk,$dest,[StringComparison]::OrdinalIgnoreCase)) {{ $temp=Join-Path $parent {}; {move_cmd}($walk,$temp); try {{ {move_cmd}($temp,$dest) }} catch {{ try {{ {move_cmd}($temp,$walk) }} catch {{ throw ({kept}+$temp) }}; throw }} }} else {{ {move_cmd}($walk,$dest) }}", ps_quote(root), ps_quote(name), ps_quote(&temporary)))
}

pub fn windows_home_dir_script(language: &str) -> String {
    let missing = ps_error(language, "目录不存在");
    format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $dir=Get-Item -LiteralPath $env:USERPROFILE -Force; if (-not $dir.PSIsContainer) {{ throw {missing} }}; @{{ path=$dir.FullName; dirs=@(Get-ChildItem -LiteralPath $dir.FullName -Directory -Force -ErrorAction Stop | ForEach-Object {{ $_.Name }}) }} | ConvertTo-Json -Compress")
}

pub fn windows_dir_script(path: &str, language: &str) -> String {
    let missing = ps_error(language, "目录不存在");
    format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $dir=Get-Item -LiteralPath {} -Force; if (-not $dir.PSIsContainer) {{ throw {missing} }}; @{{ path=$dir.FullName; dirs=@(Get-ChildItem -LiteralPath $dir.FullName -Directory -Force -ErrorAction Stop | ForEach-Object {{ $_.Name }}) }} | ConvertTo-Json -Compress", ps_quote(path))
}

pub fn windows_read_script(root: &str, relative: &str, language: &str) -> String {
    let illegal = ps_error(language, "非法路径");
    let link = ps_error(language, "符号链接不可预览");
    let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}", ps_quote(part))).collect::<Vec<_>>().join("; ");
    format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath((Join-Path $root {})); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {{ throw {illegal} }}; $walk=$root.TrimEnd('\\'); {walk}; [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))", ps_quote(root), ps_quote(&relative.replace('/', "\\")))
}

pub fn windows_write_script(root: &str, relative: &str, language: &str) -> String {
    let illegal = ps_error(language, "非法路径");
    let link = ps_error(language, "符号链接不可预览");
    let changed = ps_error(language, "文件已被其他程序修改，请重新读取后合并更改");
    let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; if ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}", ps_quote(part))).collect::<Vec<_>>().join("; ");
    format!("$ErrorActionPreference='Stop'; $root=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path.TrimEnd('\\')+'\\'; $file=[IO.Path]::GetFullPath((Join-Path $root {})); if (-not $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {{ throw {illegal} }}; $walk=$root.TrimEnd('\\'); {walk}; $temp=Join-Path (Split-Path -LiteralPath $file) ('.awb-write-' + [guid]::NewGuid().ToString() + '.tmp'); try {{ [IO.File]::WriteAllBytes($temp, [Convert]::FromBase64String([Console]::In.ReadToEnd())); [IO.File]::Replace($temp, $file, $null) }} catch {{ if (Test-Path -LiteralPath $temp) {{ Remove-Item -LiteralPath $temp -Force }}; throw {changed} }}", ps_quote(root), ps_quote(&relative.replace('/', "\\")))
}

pub fn windows_tree_script(root: &str, relative: &str, language: &str) -> String {
    let link = ps_error(language, "目录包含符号链接");
    let unsafe_dir = ps_error(language, "路径不是安全目录");
    let parts: Vec<&str> = relative.split('/').filter(|part| !part.is_empty()).collect();
    let walk = parts.iter().map(|part| format!("$walk=Join-Path $walk {}; $item=Get-Item -LiteralPath $walk -Force -ErrorAction Stop; if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) {{ throw {unsafe_dir} }}", ps_quote(part))).collect::<Vec<_>>().join("; ");
    format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $walk=(Resolve-Path -LiteralPath {} -ErrorAction Stop).Path; {walk}; foreach($item in @(Get-ChildItem -LiteralPath $walk -Force -ErrorAction Stop)) {{ if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ throw {link} }}; $name=$item.Name; @{{ path=$name; dir=[bool]$item.PSIsContainer }} | ConvertTo-Json -Compress }}", ps_quote(root), )
}

pub fn linux_create_command(root: &str, parent: &str, name: &str, directory: bool, language: &str) -> String {
    let _ = language;
    let script = r#"import os, sys
root, relative, name, directory = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
parent = os.open(root, flags)
try:
    for part in relative.split('/') if relative else []:
        nxt = os.open(part, flags | os.O_NOFOLLOW, dir_fd=parent)
        os.close(parent)
        parent = nxt
    if directory == '1':
        os.mkdir(name, dir_fd=parent)
    else:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o666, dir_fd=parent)
        os.close(fd)
finally:
    os.close(parent)
"#;
    format!("python3 -c {} {} {} {} {}", bash_quote(script), bash_quote(root), bash_quote(parent), bash_quote(name), if directory { "1" } else { "0" })
}

pub fn linux_rename_command(root: &str, relative: &str, name: &str, directory: bool, parent: &str, language: &str) -> String {
    let illegal = translate(language, "非法路径", &[] as &[String]);
    let changed = translate(language, "文件类型已更改或路径包含符号链接", &[] as &[String]);
    let unsupported = translate(language, "系统不支持安全重命名", &[] as &[String]);
    let script = format!(r#"import ctypes, errno, os, stat, sys
root, relative, name, want_dir, target_parent = sys.argv[1:]
parts = relative.split('/')
target_parts = target_parent.split('/') if target_parent else []
if not parts or any(p in ('', '.', '..') for p in parts + target_parts) or name in ('', '.', '..') or '/' in name:
    raise SystemExit({illegal})
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
fd = os.open(root, flags)
dest_fd = os.dup(fd)
try:
    for part in parts[:-1]:
        next_fd = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    for part in target_parts:
        next_fd = os.open(part, flags | os.O_NOFOLLOW, dir_fd=dest_fd)
        os.close(dest_fd)
        dest_fd = next_fd
    info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode) or (want_dir == '1' and not stat.S_ISDIR(info.st_mode)) or (want_dir == '0' and not stat.S_ISREG(info.st_mode)):
        raise SystemExit({changed})
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise SystemExit({unsupported})
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(fd, os.fsencode(parts[-1]), dest_fd, os.fsencode(name), 1) != 0:
        raise SystemExit(os.strerror(ctypes.get_errno()))
finally:
    os.close(fd)
    os.close(dest_fd)
"#, illegal = serde_json::to_string(&illegal).unwrap_or_else(|_| "\"illegal\"".into()), changed = serde_json::to_string(&changed).unwrap_or_else(|_| "\"changed\"".into()), unsupported = serde_json::to_string(&unsupported).unwrap_or_else(|_| "\"unsupported\"".into()));
    format!("python3 -c {} {} {} {} {} {}", bash_quote(&script), bash_quote(root), bash_quote(relative), bash_quote(name), if directory { "1" } else { "0" }, bash_quote(parent))
}

fn exec_command(data: &Path, host: &Value, command: &str, input: Option<&[u8]>, language: &str) -> Result<String, String> {
    if host["auth"] == "password" {
        let password = password_of(data, host).ok_or_else(|| translate(language, "请填写 SSH 登录密码", &[] as &[String]))?;
        return runtime().block_on(password_exec(data, host, &password, command, input.unwrap_or(b""), language));
    }
    key_exec(host, command, input.unwrap_or(b""), language)
}

pub fn test_connection(data: &Path, host: &Value, language: &str) -> Value {
    let addr = host["addr"].as_str().unwrap_or("");
    let user = host["user"].as_str().unwrap_or("");
    if addr.is_empty() || user.is_empty() {
        return json!({ "ok": false, "error": translate(language, "请填写用户和地址", &[] as &[String]) });
    }
    match exec_command(data, host, "uname -s 2>/dev/null || ver", None, language) {
        Ok(stdout) => {
            let line = stdout.lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("").trim();
            let linux = line.to_ascii_lowercase().contains("linux");
            json!({ "ok": true, "os": line.chars().take(80).collect::<String>(), "platform": if linux { "linux" } else { "windows" } })
        }
        Err(error) => {
            let line = error.lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("连接失败");
            json!({ "ok": false, "error": line.chars().take(240).collect::<String>() })
        }
    }
}

struct KeyState {
    mismatch: bool,
    fingerprint: String,
}

struct KeyHandler {
    state: Arc<Mutex<KeyState>>,
    file: PathBuf,
    identity: String,
}

impl client::Handler for KeyHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &russh::keys::PublicKey) -> Result<bool, Self::Error> {
        let bytes = server_public_key.to_bytes().unwrap_or_default();
        let hash = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let known = read_json(&self.file);
        let previous = known[&self.identity].as_str().unwrap_or("");
        let mut state = self.state.lock().expect("key");
        state.fingerprint = hash.clone();
        if !previous.is_empty() && previous != hash {
            state.mismatch = true;
            return Ok(false);
        }
        Ok(true)
    }
}

/// How long one step of reaching a server may take, as long as the Electron
/// build waits for a server to be ready. A server that accepts the connection
/// and then says nothing must be given up, or the question asked of it is
/// never answered.
const REACH_LIMIT: Duration = Duration::from_secs(12);

/// Runs one step of reaching a server. `None` when the step did not end in
/// time; what to say about that is for the one that asked.
async fn within<T>(step: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::time::timeout(REACH_LIMIT, step).await.ok()
}

fn timed_out(language: &str) -> String {
    translate(language, "SSH 连接超时", &[] as &[String])
}

/// Connect to a server with a password and have the host key checked, as
/// every command and stream to a password host starts. The key the server
/// offers is compared with the one remembered for it; a different one ends
/// the connection before anything is sent.
async fn open_password(data: &Path, host: &Value, password: &str, language: &str) -> Result<client::Handle<KeyHandler>, String> {
    let addr = host["addr"].as_str().unwrap_or("");
    let user = host["user"].as_str().unwrap_or("");
    let port = host_port(host);
    let state = Arc::new(Mutex::new(KeyState { mismatch: false, fingerprint: String::new() }));
    let handler = KeyHandler { state: state.clone(), file: fingerprint_file(data), identity: key_identity(addr, port) };
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(15)), ..client::Config::default() });
    let mut session = match within(client::connect(config, (addr, port), handler)).await {
        Some(Ok(session)) => session,
        Some(Err(error)) => {
            if state.lock().expect("key").mismatch { return Err(translate(language, "SSH 主机密钥已改变", &[] as &[String])) }
            return Err(error.to_string());
        }
        None => return Err(timed_out(language)),
    };
    let authed = within(session.authenticate_password(user, password)).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    if !matches!(authed, AuthResult::Success) {
        let started = within(session.authenticate_keyboard_interactive_start(user, None)).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
        match started {
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } if prompts.len() == 1 && !prompts[0].echo && prompts[0].prompt.to_ascii_lowercase().contains("password") => {
                let reply = within(session.authenticate_keyboard_interactive_respond(vec![password.to_string()])).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
                if !matches!(reply, KeyboardInteractiveAuthResponse::Success) { return Err(translate(language, "SSH 连接在认证完成前关闭", &[] as &[String])) }
            }
            KeyboardInteractiveAuthResponse::Success => {}
            _ => return Err(translate(language, "SSH 连接在认证完成前关闭", &[] as &[String])),
        }
    }
    let fingerprint = state.lock().expect("key").fingerprint.clone();
    let mut known = read_json(&fingerprint_file(data));
    if !known.is_object() { known = json!({}); }
    let stored = known[&key_identity(addr, port)].as_str().unwrap_or("");
    if !stored.is_empty() && stored != fingerprint { return Err(translate(language, "SSH 主机密钥已改变", &[] as &[String])) }
    known[&key_identity(addr, port)] = json!(fingerprint);
    write_private(&fingerprint_file(data), &known)?;
    Ok(session)
}

/// Open a channel on an authenticated session, start a command on it and
/// hand it its input. The channel is returned with the input sent.
async fn start_command(session: &client::Handle<KeyHandler>, command: &str, input: &[u8], language: &str) -> Result<russh::Channel<client::Msg>, String> {
    let channel = within(session.channel_open_session()).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    within(channel.exec(true, command.as_bytes().to_vec())).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    if !input.is_empty() {
        within(channel.data(&input[..])).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    }
    within(channel.eof()).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    Ok(channel)
}

async fn password_exec(data: &Path, host: &Value, password: &str, command: &str, input: &[u8], language: &str) -> Result<String, String> {
    let session = open_password(data, host, password, language).await?;
    let mut channel = start_command(&session, command, input, language).await?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(20) { return Err(translate(language, "远程命令执行超时", &[] as &[String])) }
        let Some(message) = channel.wait().await else { break };
        match message {
            ChannelMsg::Data { data } => {
                stdout.extend_from_slice(&data);
                if stdout.len() > MAX_OUTPUT { return Err(translate(language, "远程输出过大", &[] as &[String])) }
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.extend_from_slice(&data);
                if stderr.len() > 16000 { stderr.drain(..stderr.len() - 16000); }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    if code == Some(0) { return Ok(String::from_utf8_lossy(&stdout).into_owned()) }
    let detail = String::from_utf8_lossy(&stderr).trim().to_string();
    if !detail.is_empty() { return Err(detail) }
    match code {
        None => Err(translate(language, "SSH 连接中断", &[] as &[String])),
        Some(code) => Err(translate(language, "远程命令退出码 {{0}}", &[code.to_string()])),
    }
}

fn ssh_program() -> String {
    std::env::var("AWB_SSH_BIN").unwrap_or_else(|_| "ssh".into())
}

fn ssh_home() -> Option<PathBuf> {
    std::env::var_os("AWB_SSH_HOME").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

pub fn ssh_batch_args(host: &Value) -> Vec<String> {
    let mut args = vec![
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-p".into(),
        host_port(host).to_string(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
    ];
    if host["auth"].as_str() == Some("key") {
        if let Some(home) = ssh_home() {
            let key = home.join(".ssh/id_ed25519");
            if key.is_file() {
                args.push("-o".into());
                args.push("IdentitiesOnly=yes".into());
                args.push("-i".into());
                args.push(key.to_string_lossy().into_owned());
            }
        }
    }
    args.push(format!("{}@{}", host["user"].as_str().unwrap_or(""), host["addr"].as_str().unwrap_or("")));
    args
}

/// Stream one local file to a remote command. File bytes are written in chunks,
/// then a single confirmation byte. A cancel closes the session before that byte.
pub fn stream_file(data: &Path, host: &Value, command: &str, source: &Path, total: u64, progress: &(dyn Fn(u64) + Send + Sync), cancel: &AtomicBool, language: &str) -> Result<String, String> {
    if host["auth"] == "password" {
        let password = password_of(data, host).ok_or_else(|| translate(language, "请填写 SSH 登录密码", &[] as &[String]))?;
        return runtime().block_on(password_stream(data, host, &password, command, source, total, progress, cancel, language));
    }
    key_stream(host, command, source, total, progress, cancel, language)
}

fn open_upload_source(source: &Path, total: u64, language: &str) -> Result<(std::fs::File, Option<std::time::SystemTime>), String> {
    let meta = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() { return Err(translate(language, "不上传符号链接", &[] as &[String])) }
    if !meta.is_file() { return Err(translate(language, "仅支持上传普通文件", &[] as &[String])) }
    if meta.len() != total { return Err(translate(language, "来源文件已更改或传输已取消", &[] as &[String])) }
    let file = crate::sys::open_read_nofollow(source).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != total { return Err(translate(language, "来源文件已更改或传输已取消", &[] as &[String])) }
    Ok((file, opened.modified().ok()))
}

fn source_unchanged(file: &std::fs::File, total: u64, started: Option<std::time::SystemTime>, language: &str) -> Result<(), String> {
    let after = file.metadata().map_err(|error| error.to_string())?;
    if after.len() != total || after.modified().ok() != started {
        return Err(translate(language, "来源文件已更改或传输已取消", &[] as &[String]));
    }
    Ok(())
}

fn key_stream(host: &Value, command: &str, source: &Path, total: u64, progress: &(dyn Fn(u64) + Send + Sync), cancel: &AtomicBool, language: &str) -> Result<String, String> {
    let (mut file, started) = open_upload_source(source, total, language)?;
    let mut ssh = std::process::Command::new(ssh_program());
    for arg in ssh_batch_args(host) { ssh.arg(arg); }
    ssh.arg(command);
    ssh.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = ssh.spawn().map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or_else(|| translate(language, "上传失败", &[] as &[String]))?;
    let mut buffer = vec![0u8; 32 * 1024];
    let mut sent = 0u64;
    while sent < total {
        if cancel.load(Ordering::SeqCst) { let _ = child.kill(); return Err(translate(language, "传输已取消", &[] as &[String])) }
        let want = std::cmp::min(buffer.len() as u64, total - sent) as usize;
        file.read_exact(&mut buffer[..want]).map_err(|error| error.to_string())?;
        progress(sent + want as u64);
        if stdin.write_all(&buffer[..want]).is_err() { let _ = child.kill(); return Err(translate(language, "传输中断", &[] as &[String])) }
        sent += want as u64;
    }
    if cancel.load(Ordering::SeqCst) { let _ = child.kill(); return Err(translate(language, "传输已取消", &[] as &[String])) }
    if let Err(error) = source_unchanged(&file, total, started, language) { let _ = child.kill(); return Err(error) }
    if stdin.write_all(&[1]).is_err() { let _ = child.kill(); return Err(translate(language, "传输中断", &[] as &[String])) }
    drop(stdin);
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if output.stdout.len() > MAX_OUTPUT { return Err(translate(language, "远程输出过大", &[] as &[String])) }
    if output.status.success() { return Ok(String::from_utf8_lossy(&output.stdout).into_owned()) }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !detail.is_empty() { return Err(detail.chars().rev().take(240).collect::<String>().chars().rev().collect()) }
    Err(translate(language, "SSH 退出码 {{0}}", &[output.status.code().unwrap_or(-1).to_string()]))
}

async fn until_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn password_stream(data: &Path, host: &Value, password: &str, command: &str, source: &Path, total: u64, progress: &(dyn Fn(u64) + Send + Sync), cancel: &AtomicBool, language: &str) -> Result<String, String> {
    let (mut file, started) = open_upload_source(source, total, language)?;
    let session = open_password(data, host, password, language).await?;
    let mut channel = within(session.channel_open_session()).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    within(channel.exec(true, command.as_bytes().to_vec())).await.ok_or_else(|| timed_out(language))?.map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; 32 * 1024];
    let mut sent = 0u64;
    while sent < total {
        if cancel.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(Duration::from_secs(2), session.disconnect(Disconnect::ByApplication, "", "en")).await;
            return Err(translate(language, "传输已取消", &[] as &[String]));
        }
        let want = std::cmp::min(buffer.len() as u64, total - sent) as usize;
        file.read_exact(&mut buffer[..want]).map_err(|error| error.to_string())?;
        progress(sent + want as u64);
        let write = channel.data(&buffer[..want]);
        tokio::pin!(write);
        tokio::select! {
            biased;
            result = &mut write => { result.map_err(|error| error.to_string())?; }
            _ = until_cancel(cancel) => {
                drop(write);
                let _ = tokio::time::timeout(Duration::from_secs(2), session.disconnect(Disconnect::ByApplication, "", "en")).await;
                return Err(translate(language, "传输已取消", &[] as &[String]));
            }
        }
        sent += want as u64;
    }
    if cancel.load(Ordering::SeqCst) {
        let _ = tokio::time::timeout(Duration::from_secs(2), session.disconnect(Disconnect::ByApplication, "", "en")).await;
        return Err(translate(language, "传输已取消", &[] as &[String]));
    }
    source_unchanged(&file, total, started, language)?;
    let confirm = [1u8];
    channel.data(&confirm[..]).await.map_err(|error| error.to_string())?;
    channel.eof().await.map_err(|error| error.to_string())?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    let started_at = std::time::Instant::now();
    loop {
        if started_at.elapsed() > Duration::from_secs(120) { return Err(translate(language, "远程命令执行超时", &[] as &[String])) }
        let Some(message) = channel.wait().await else { break };
        match message {
            ChannelMsg::Data { data } => {
                stdout.extend_from_slice(&data);
                if stdout.len() > MAX_OUTPUT { return Err(translate(language, "远程输出过大", &[] as &[String])) }
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.extend_from_slice(&data);
                if stderr.len() > 16000 { stderr.drain(..stderr.len() - 16000); }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    if code == Some(0) { return Ok(String::from_utf8_lossy(&stdout).into_owned()) }
    let detail = String::from_utf8_lossy(&stderr).trim().to_string();
    if !detail.is_empty() { return Err(detail) }
    match code {
        None => Err(translate(language, "SSH 连接中断", &[] as &[String])),
        Some(code) => Err(translate(language, "远程命令退出码 {{0}}", &[code.to_string()])),
    }
}

/// A remote command whose output is read as it comes, one line at a time, as
/// a search on a remote host reports what it finds. Dropping it ends the
/// command on the host, so the worker of a search that is cancelled is not
/// left running there.
pub struct CommandStream {
    lines: std::sync::mpsc::Receiver<String>,
    errors: Arc<Mutex<Vec<u8>>>,
    code: Arc<Mutex<Option<i32>>>,
    cancel: Arc<AtomicBool>,
    language: String,
}

impl CommandStream {
    /// The next line of the command's output, without its line break. Waits
    /// for one as long as the command is still running; `None` once the
    /// output has ended or the stream was cancelled. `finish` then says how
    /// the command went.
    pub fn next_line(&self) -> Option<String> {
        loop {
            match self.lines.recv_timeout(Duration::from_millis(200)) {
                Ok(line) => return Some(line),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if self.cancelled() { return None }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    /// Whether the stream was cancelled, by being dropped or by its flag.
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// The flag that cancels this stream from elsewhere.
    pub fn cancel_flag(&self) -> CancelFlag {
        CancelFlag(Arc::clone(&self.cancel))
    }

    /// Wait for the command to end and say whether it succeeded. An error
    /// carries what the command printed, or its exit code.
    pub fn finish(&self) -> Result<(), String> {
        while self.next_line().is_some() {}
        if self.cancel.load(Ordering::SeqCst) { return Err(translate(&self.language, "搜索已取消", &[] as &[String])) }
        let detail = String::from_utf8_lossy(&self.errors.lock().expect("command errors")).trim().to_string();
        let code = *self.code.lock().expect("command code");
        match code {
            Some(0) => Ok(()),
            _ if !detail.is_empty() => Err(detail.chars().rev().take(240).collect::<String>().chars().rev().collect()),
            Some(code) => Err(translate(&self.language, "远程命令退出码 {{0}}", &[code.to_string()])),
            None => Err(translate(&self.language, "SSH 连接中断", &[] as &[String])),
        }
    }
}

impl Drop for CommandStream {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// The flag by which a `CommandStream` is cancelled. A search holds on to it
/// so that it can be stopped while its next batch is still being waited for.
#[derive(Clone)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn new() -> Self {
        CancelFlag(Arc::new(AtomicBool::new(false)))
    }
    pub(crate) fn into_shared(self) -> Arc<AtomicBool> {
        self.0
    }
    pub(crate) fn from_shared(flag: Arc<AtomicBool>) -> Self {
        CancelFlag(flag)
    }
    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The reader of a stream: it turns the command's bytes into lines and hands
/// them to the caller, and it ends the session when the stream is dropped.
struct StreamPump {
    sender: std::sync::mpsc::Sender<String>,
    errors: Arc<Mutex<Vec<u8>>>,
    code: Arc<Mutex<Option<i32>>>,
    cancel: Arc<AtomicBool>,
}

impl StreamPump {
    fn send(&self, bytes: &[u8], pending: &mut Vec<u8>) {
        pending.extend_from_slice(bytes);
        while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            let line = line.strip_suffix('\r').unwrap_or(&line).to_string();
            if self.sender.send(line).is_err() { return }
        }
        // A line without a break that grows past what a result line can be is
        // not held back for a break that is not coming.
        if pending.len() > MAX_LINE {
            let line = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            let _ = self.sender.send(line);
        }
    }
}

/// Above this a line is handed over without its break: the largest event a
/// search script emits holds a file's matches, never more.
const MAX_LINE: usize = 4_000_000;

/// Start a command on a remote host and read its output as it comes. The
/// input is written to the command and the input is closed first, so the
/// command has its query before it says anything.
pub fn open_command_stream(data: &Path, host: &Value, command: &str, input: &[u8], language: &str) -> Result<CommandStream, String> {
    let (sender, lines) = std::sync::mpsc::channel();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let code = Arc::new(Mutex::new(None));
    let cancel = Arc::new(AtomicBool::new(false));
    if host["auth"] == "password" {
        let password = password_of(data, host).ok_or_else(|| translate(language, "请填写 SSH 登录密码", &[] as &[String]))?;
        // The connection is made here, where a failure can be reported before
        // anything is read; only the reading is left to the pump. The session
        // goes with it: a session nobody keeps is a connection nobody ends.
        let (session, channel) = runtime().block_on(async {
            let session = open_password(data, host, &password, language).await?;
            let channel = start_command(&session, command, input, language).await?;
            Ok::<_, String>((session, channel))
        })?;
        let pump = StreamPump { sender, errors: Arc::clone(&errors), code: Arc::clone(&code), cancel: Arc::clone(&cancel) };
        // The command runs for as long as it has something to say, as on the
        // Electron build: a search through a large project is not cut short,
        // and stopping it is the user's doing.
        runtime().spawn(async move {
            let mut pending = Vec::new();
            let mut channel = channel;
            loop {
                if pump.cancel.load(Ordering::SeqCst) { break }
                let message = tokio::time::timeout(Duration::from_millis(200), channel.wait()).await;
                match message {
                    Err(_elapsed) => continue,
                    Ok(None) => break,
                    Ok(Some(ChannelMsg::Data { data })) => pump.send(&data, &mut pending),
                    Ok(Some(ChannelMsg::ExtendedData { data, ext: 1 })) => {
                        let mut held = pump.errors.lock().expect("command errors");
                        held.extend_from_slice(&data);
                        if held.len() > 16000 { let cut = held.len() - 16000; held.drain(..cut); }
                    }
                    Ok(Some(ChannelMsg::ExitStatus { exit_status })) => *pump.code.lock().expect("command code") = Some(exit_status as i32),
                    Ok(Some(_)) => {}
                }
            }
            // A last line that ends without a break is still a line.
            if !pending.is_empty() { let _ = pump.sender.send(String::from_utf8_lossy(&pending).into_owned()); }
            // Closing the channel is what ends the command on the host, when
            // the stream was dropped before the command had finished; the
            // session is ended after it, as the Electron build ends its client.
            let _ = channel.close().await;
            let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
        });
    } else {
        let mut ssh = std::process::Command::new(ssh_program());
        for arg in ssh_batch_args(host) { ssh.arg(arg); }
        ssh.arg(command);
        ssh.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = ssh.spawn().map_err(|error| error.to_string())?;
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(input); }
        let mut stdout = child.stdout.take().ok_or_else(|| translate(language, "远程输出过大", &[] as &[String]))?;
        let mut stderr = child.stderr.take().ok_or_else(|| translate(language, "远程输出过大", &[] as &[String]))?;
        // The error output has a thread of its own: read on the same thread
        // as the output, a pipe that has nothing to say yet would hold back
        // the lines that are ready.
        let tail: Arc<Mutex<Vec<u8>>> = Arc::clone(&errors);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        let mut tail = tail.lock().expect("command errors");
                        tail.extend_from_slice(&buffer[..size]);
                        if tail.len() > 16000 { let cut = tail.len() - 16000; tail.drain(..cut); }
                    }
                }
            }
        });
        // The child is kept alive here and ended on cancel: ending it is what
        // makes the blocked read return.
        let child = Arc::new(Mutex::new(Some(child)));
        let to_end = Arc::clone(&child);
        let watching = Arc::clone(&cancel);
        std::thread::spawn(move || {
            while !watching.load(Ordering::SeqCst) {
                let ended = { let mut held = to_end.lock().expect("child"); held.as_mut().map(|child| child.try_wait().ok().flatten().is_some()).unwrap_or(true) };
                if ended { break }
                std::thread::sleep(Duration::from_millis(40));
            }
            let mut held = to_end.lock().expect("child");
            if watching.load(Ordering::SeqCst) { if let Some(child) = held.as_mut() { let _ = child.kill(); } }
        });
        let pump = StreamPump { sender, errors: Arc::clone(&errors), code: Arc::clone(&code), cancel: Arc::clone(&cancel) };
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => pump.send(&buffer[..size], &mut pending),
                }
            }
            if !pending.is_empty() { let _ = pump.sender.send(String::from_utf8_lossy(&pending).into_owned()); }
            let status = { let mut held = child.lock().expect("child"); held.take().map(|mut child| child.wait()) };
            *pump.code.lock().expect("command code") = status.and_then(|result| result.ok()).and_then(|status| status.code());
        });
    }
    Ok(CommandStream { lines, errors, code, cancel, language: language.to_string() })
}

fn key_exec(host: &Value, command: &str, input: &[u8], language: &str) -> Result<String, String> {
    let mut ssh = std::process::Command::new(ssh_program());
    for arg in ssh_batch_args(host) { ssh.arg(arg); }
    ssh.arg(command);
    ssh.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = ssh.spawn().map_err(|error| error.to_string())?;
    if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(input); }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if output.stdout.len() > MAX_OUTPUT { return Err(translate(language, "远程输出过大", &[] as &[String])) }
    if output.status.success() { return Ok(String::from_utf8_lossy(&output.stdout).into_owned()) }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !detail.is_empty() { return Err(detail.chars().rev().take(240).collect::<String>().chars().rev().collect()) }
    Err(translate(language, "SSH 退出码 {{0}}", &[output.status.code().unwrap_or(-1).to_string()]))
}

pub struct RemoteShell {
    pub output: Box<dyn Read + Send>,
    pub input: Box<dyn Write + Send>,
    pub stop: Box<dyn FnOnce() + Send>,
}

pub fn open_shell(data: &Path, host: &Value, cwd: &str, language: &str) -> Result<RemoteShell, String> {
    let script = remote_bootstrap(cwd);
    let command = remote_command(host["platform"].as_str().unwrap_or("linux"), &[String::from("bash"), String::from("-lc"), script]);
    let (output_read, output_write) = std::io::pipe().map_err(|error| error.to_string())?;
    let (input_read, input_write) = std::io::pipe().map_err(|error| error.to_string())?;
    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = stop_flag.clone();
    let (typed, mut keys) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    // Keystrokes arrive on a blocking pipe; forward them to the async pump.
    std::thread::spawn(move || {
        let mut reader = input_read;
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => { if typed.blocking_send(buffer[..size].to_vec()).is_err() { break } }
            }
        }
    });
    let data = data.to_path_buf();
    let host = host.clone();
    let language = language.to_string();
    std::thread::spawn(move || {
        let _ = runtime().block_on(pump_shell(&data, &host, &command, output_write, &mut keys, flag, &language));
    });
    Ok(RemoteShell {
        output: Box::new(output_read),
        input: Box::new(input_write),
        stop: Box::new(move || stop_flag.store(true, std::sync::atomic::Ordering::Relaxed)),
    })
}

async fn pump_shell(data: &Path, host: &Value, command: &str, mut output: std::io::PipeWriter, keys: &mut tokio::sync::mpsc::Receiver<Vec<u8>>, stop: Arc<std::sync::atomic::AtomicBool>, language: &str) -> Result<(), String> {
    let password = password_of(data, host).ok_or_else(|| translate(language, "请填写 SSH 登录密码", &[] as &[String]))?;
    let addr = host["addr"].as_str().unwrap_or("");
    let port = host_port(host);
    let state = Arc::new(Mutex::new(KeyState { mismatch: false, fingerprint: String::new() }));
    let handler = KeyHandler { state: state.clone(), file: fingerprint_file(data), identity: key_identity(addr, port) };
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (addr, port), handler).await.map_err(|error| error.to_string())?;
    session.authenticate_password(host["user"].as_str().unwrap_or(""), &password).await.map_err(|error| error.to_string())?;
    let fingerprint = state.lock().expect("key").fingerprint.clone();
    let mut known = read_json(&fingerprint_file(data));
    known[&key_identity(addr, port)] = json!(fingerprint);
    let _ = write_private(&fingerprint_file(data), &known);
    let mut channel = session.channel_open_session().await.map_err(|error| error.to_string())?;
    channel.request_pty(false, "xterm-256color", 80, 24, 0, 0, &[] as &[(russh::Pty, u32)]).await.map_err(|error| error.to_string())?;
    channel.exec(false, command.as_bytes().to_vec()).await.map_err(|error| error.to_string())?;
    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) { break }
        tokio::select! {
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => { let _ = output.write_all(&data); }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            typed = keys.recv() => {
                match typed {
                    None => break,
                    Some(bytes) => { let _ = channel.data(&bytes[..]).await; }
                }
            }
        }
    }
    let _ = channel.close().await;
    Ok(())
}

pub struct Fixture {
    pub port: u16,
    closed: Arc<std::sync::atomic::AtomicUsize>,
    shutdown: Option<server::RunningServerHandle>,
}

impl Fixture {
    /// How many channels the client has closed so far.
    pub fn closed_channels(&self) -> usize {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(handle) = self.shutdown.take() { handle.shutdown("stop".into()); }
    }
}

struct FixtureServer {
    password: String,
    closed: Arc<std::sync::atomic::AtomicUsize>,
}

struct FixtureClient {
    password: String,
    closed: Arc<std::sync::atomic::AtomicUsize>,
    commands: HashMap<ChannelId, String>,
    stdin: HashMap<ChannelId, Vec<u8>>,
    pty: HashMap<ChannelId, bool>,
    writers: HashMap<ChannelId, tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
}

impl server::Server for FixtureServer {
    type Handler = FixtureClient;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        FixtureClient { password: self.password.clone(), closed: Arc::clone(&self.closed), commands: HashMap::new(), stdin: HashMap::new(), pty: HashMap::new(), writers: HashMap::new() }
    }
}

impl server::Handler for FixtureClient {
    type Error = russh::Error;

    async fn channel_open_session(&mut self, _channel: russh::Channel<server::Msg>, _session: &mut server::Session) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn auth_password(&mut self, _: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == self.password { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_keyboard_interactive<'a>(&'a mut self, _user: &str, _submethods: &str, response: Option<server::Response<'a>>) -> Result<Auth, Self::Error> {
        match response {
            None => Ok(Auth::Partial { name: Cow::Borrowed(""), instructions: Cow::Borrowed(""), prompts: Cow::Borrowed(&[(Cow::Borrowed("Password: "), false)]) }),
            Some(mut response) => {
                let answer = response.next().map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
                Ok(if answer == self.password { Auth::Accept } else { Auth::reject() })
            }
        }
    }

    async fn pty_request(&mut self, channel: ChannelId, _: &str, _: u32, _: u32, _: u32, _: u32, _: &[(russh::Pty, u32)], session: &mut server::Session) -> Result<(), Self::Error> {
        self.pty.insert(channel, true);
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut server::Session) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        self.commands.insert(channel, String::from_utf8_lossy(data).into_owned());
        if self.pty.get(&channel) == Some(&true) {
            let command = self.commands.remove(&channel).unwrap_or_default();
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            self.writers.insert(channel, sender);
            let handle = session.handle();
            tokio::spawn(async move { run_pty(handle, channel, command, receiver).await });
        }
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], _: &mut server::Session) -> Result<(), Self::Error> {
        if let Some(sender) = self.writers.get(&channel) {
            let _ = sender.send(data.to_vec());
            return Ok(());
        }
        self.stdin.entry(channel).or_default().extend_from_slice(data);
        Ok(())
    }

    async fn channel_close(&mut self, _channel: ChannelId, _session: &mut server::Session) -> Result<(), Self::Error> {
        self.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, session: &mut server::Session) -> Result<(), Self::Error> {
        if self.pty.get(&channel) == Some(&true) { return Ok(()) }
        let command = self.commands.remove(&channel).unwrap_or_default();
        let input = self.stdin.remove(&channel).unwrap_or_default();
        // A command asked for by name `awb-hold:` is a command that does not
        // end by itself: it answers with its lines, each behind a line break,
        // and then keeps the channel open without an exit status until the
        // client closes it. The closing is counted for the caller. A content
        // search for `hold` is answered the same way, with more files than
        // one batch holds, so that a search can be followed as it comes and
        // stopped while it waits for what is left.
        // The content search on a POSIX host is started as `bash -lc
        // 'python3 -u -c …'`. It is recognised by that program name, so that
        // the test does not depend on how the shell quotes the script.
        let search_holds = command.contains("python3 -u -c ") && serde_json::from_slice::<serde_json::Value>(&input).ok().and_then(|query| query["query"].as_str().map(|query| query == "hold")).unwrap_or(false);
        let held = match command.strip_prefix("awb-hold:") {
            Some(lines) => Some(lines.to_string()),
            None if search_holds => Some((0..40).map(|index| json!({ "file": { "path": format!("src/file{index}.txt"), "matches": [{ "line": index + 1, "column": 1, "text": "hold", "before": "", "after": "" }] } }).to_string()).collect::<Vec<String>>().join("|")),
            None => None,
        };
        if let Some(lines) = held {
            for line in lines.split('|') {
                let _ = session.data(channel, CryptoVec::from(format!("{line}\n").as_bytes()));
            }
            let _ = session.flush();
            return Ok(());
        }
        let output = tokio::process::Command::new("bash").arg("-lc").arg(command).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn();
        let Ok(mut child) = output else {
            let _ = session.exit_status_request(channel, 127);
            let _ = session.eof(channel);
            return Ok(());
        };
        if let Some(mut stdin) = child.stdin.take() { let _ = tokio::io::AsyncWriteExt::write_all(&mut stdin, &input).await; }
        let finished = child.wait_with_output().await;
        if let Ok(finished) = finished {
            if !finished.stdout.is_empty() { let _ = session.data(channel, CryptoVec::from(finished.stdout)); }
            if !finished.stderr.is_empty() { let _ = session.extended_data(channel, 1, CryptoVec::from(finished.stderr)); }
            let _ = session.exit_status_request(channel, finished.status.code().unwrap_or(1) as u32);
        }
        let _ = session.eof(channel);
        let _ = session.close(channel);
        Ok(())
    }
}

async fn run_pty(handle: server::Handle, channel: ChannelId, command: String, mut input: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
    let mut child = match tokio::process::Command::new("python3")
        .arg("-c")
        .arg("import pty,sys; pty.spawn(['bash','-lc', sys.argv[1]])")
        .arg(command)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return,
    };
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            while let Some(bytes) = input.recv().await {
                if tokio::io::AsyncWriteExt::write_all(&mut stdin, &bytes).await.is_err() { break }
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut stdout = stdout;
            let mut buffer = [0u8; 4096];
            loop {
                match tokio::io::AsyncReadExt::read(&mut stdout, &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => { let _ = handle.data(channel, CryptoVec::from(&buffer[..size])).await; }
                }
            }
            let _ = handle.eof(channel).await;
        });
    }
    let _ = child.wait().await;
}

pub fn start_fixture(password: &str) -> Result<Fixture, String> {
    start_fixture_with(password, HostKey::Ed25519)
}

/// The kind of host key a fixture server offers. Most servers in use offer
/// RSA, so a client that cannot take it cannot reach most servers.
#[derive(Clone, Copy, Debug)]
pub enum HostKey {
    Ed25519,
    Rsa,
}

pub fn start_fixture_with(password: &str, host_key: HostKey) -> Result<Fixture, String> {
    let password = password.to_string();
    let (port_tx, port_rx) = std::sync::mpsc::channel();
    let (handle_tx, handle_rx) = std::sync::mpsc::channel();
    runtime().spawn(async move {
        let algorithm = match host_key {
            HostKey::Ed25519 => Algorithm::Ed25519,
            #[cfg(feature = "ssh-rsa")]
            HostKey::Rsa => Algorithm::Rsa { hash: None },
            // Without RSA support there is no RSA key to offer; the case that
            // asks for one is refused below, before any connection is made.
            #[cfg(not(feature = "ssh-rsa"))]
            HostKey::Rsa => {
                let _ = port_tx.send(Err("this build has no RSA host key support".to_string()));
                return;
            }
        };
        let key = PrivateKey::random(&mut rand::rngs::OsRng, algorithm).expect("host key");
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..server::Config::default()
        });
        let socket = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(socket) => socket,
            Err(error) => { let _ = port_tx.send(Err(error.to_string())); return }
        };
        let port = match socket.local_addr() {
            Ok(addr) => addr.port(),
            Err(error) => { let _ = port_tx.send(Err(error.to_string())); return }
        };
        let _ = port_tx.send(Ok(port));
        let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut server = FixtureServer { password, closed: Arc::clone(&closed) };
        let running = server.run_on_socket(config, &socket);
        let _ = handle_tx.send((running.handle(), Arc::clone(&closed)));
        let _ = running.await;
    });
    let port = port_rx.recv().map_err(|error| error.to_string())??;
    let (shutdown, closed) = handle_rx.recv_timeout(Duration::from_secs(5)).map(|(handle, closed)| (Some(handle), closed)).unwrap_or_else(|_| (None, Arc::new(std::sync::atomic::AtomicUsize::new(0))));
    Ok(Fixture { port, closed, shutdown })
}
