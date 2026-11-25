//! Local shell discovery. Linux looks up bash and zsh; Windows finds
//! PowerShell, CMD and Git Bash. Managed startup files stay under the install
//! data directory.

use crate::i18n::translate;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct LocalShell {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
}

/// Git for Windows roots learned from the registry, which is read only when
/// the known locations hold no Bash.
static REGISTRY_GIT_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub fn discover() -> Vec<LocalShell> {
    if !cfg!(windows) {
        let mut shells = Vec::new();
        if let Some(path) = which("bash").or_else(|| existing("/bin/bash")).or_else(|| existing("/usr/bin/bash")) {
            shells.push(LocalShell { id: "bash".into(), label: "bash".into(), path });
        }
        if let Some(path) = which("zsh").or_else(|| existing("/bin/zsh")).or_else(|| existing("/usr/bin/zsh")) {
            shells.push(LocalShell { id: "zsh".into(), label: "zsh".into(), path });
        }
        return shells;
    }
    let registry = REGISTRY_GIT_ROOTS.lock().expect("git roots").clone();
    let mut shells = find_windows(&registry);
    if !shells.iter().any(|shell| shell.id == "bash") {
        let mut roots = REGISTRY_GIT_ROOTS.lock().expect("git roots");
        for hive in ["HKLM", "HKCU"] {
            if let Some(root) = registry_git_root(hive) {
                if root.is_absolute() && !roots.contains(&root) { roots.push(root); }
            }
        }
        shells = find_windows(&roots);
    }
    shells
}

/// One pass over the environment. `git_roots` are install locations already
/// known; the registry is consulted by `discover` alone.
fn find_windows(git_roots: &[PathBuf]) -> Vec<LocalShell> {
    let directories: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).filter(|directory| !directory.as_os_str().is_empty()).collect()).unwrap_or_default();
    let first = |names: &[&str], additional: Vec<PathBuf>| -> Option<PathBuf> {
        additional.into_iter().chain(directories.iter().flat_map(|directory| names.iter().map(move |name| directory.join(name)))).find(|file| is_executable(file))
    };
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let windows = env("SystemRoot").or_else(|| env("WINDIR")).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let programs: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"].iter().filter_map(|name| env(name)).collect();
    let mut shells = Vec::new();
    let powershell = first(&["pwsh.exe"], programs.iter().map(|root| root.join("PowerShell").join("7").join("pwsh.exe")).collect())
        .or_else(|| first(&["powershell.exe"], vec![windows.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe")]));
    if let Some(path) = powershell {
        shells.push(LocalShell { id: "pwsh".into(), label: "PowerShell".into(), path: real(&path) });
    }
    if let Some(path) = first(&["cmd.exe"], vec![env("ComSpec").unwrap_or_else(|| windows.join("System32").join("cmd.exe"))]) {
        shells.push(LocalShell { id: "cmd".into(), label: "CMD".into(), path: real(&path) });
    }
    let mut git_roots: Vec<PathBuf> = git_roots.to_vec();
    git_roots.extend(programs.iter().map(|root| root.join("Git")));
    if let Some(local) = env("LOCALAPPDATA") {
        git_roots.push(local.join("Programs").join("Git"));
        git_roots.push(local.join("Git"));
    }
    // A `git.exe` on the PATH names its installation: the folder above the
    // `bin` or `cmd` folder that holds it.
    git_roots.extend(directories.iter().filter(|directory| is_executable(&directory.join("git.exe"))).map(|directory| directory.parent().map(Path::to_path_buf).unwrap_or_default()));
    let git_bash = git_roots.iter().flat_map(|root| [root.join("bin").join("bash.exe"), root.join("usr").join("bash.exe")]).find(|file| is_executable(file));
    // System32 bash.exe starts WSL and cannot accept the managed Windows rc file.
    let system = windows.to_string_lossy().to_lowercase() + "\\";
    let native_bash = directories.iter().map(|directory| directory.join("bash.exe")).find(|file| !file.to_string_lossy().to_lowercase().starts_with(&system) && is_executable(file));
    // The label says which was found, so that is decided before either is taken.
    let from_git = git_bash.is_some();
    if let Some(path) = git_bash.or(native_bash) {
        shells.push(LocalShell { id: "bash".into(), label: if from_git { "Git Bash" } else { "bash" }.into(), path: real(&path) });
    }
    shells
}

/// Where Git for Windows says it is installed, in either hive.
fn registry_git_root(hive: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("reg.exe").args(["query", &format!("{hive}\\Software\\GitForWindows"), "/v", "InstallPath"]).output().ok()?;
    if !output.status.success() { return None }
    let text = String::from_utf8_lossy(&output.stdout);
    let value = text.lines().find_map(|line| {
        let (_, rest) = line.split_once("InstallPath")?;
        let mut fields = rest.split_whitespace();
        if fields.next() != Some("REG_SZ") { return None }
        Some(fields.collect::<Vec<_>>().join(" ").trim().to_string())
    })?;
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn real(path: &Path) -> PathBuf {
    crate::real_path(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn command_exists(name: &str) -> bool {
    which(name).is_some()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if is_executable(&candidate) { return Some(crate::real_path(&candidate).unwrap_or(candidate)) }
    }
    None
}

fn existing(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    is_executable(&path).then(|| crate::real_path(&path).unwrap_or(path))
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() { return false }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path).map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn installed_agents() -> Value {
    let mut map = serde_json::Map::new();
    for command in ["claude", "codex", "opencode", "pi", "omp"] {
        map.insert(command.into(), json!(command_exists(command)));
    }
    Value::Object(map)
}

pub const BASH_RC: &str = r#"# Keep user-installed commands, aliases and environment in managed shells.
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
unset HISTFILE
PS1='\w\$ '
__awb_prompt() {
  local c=$?
  printf '\033]777;awb;prompt;%s\007' "$c"
}
PROMPT_COMMAND=__awb_prompt
if [ -n "$AWB_CWD" ] && [ -d "$AWB_CWD" ]; then
  cd "$AWB_CWD" || true
fi
"#;

pub const ZSH_RC: &str = r#"unset HISTFILE
PS1='%d$ '
precmd() {
  local c=$?
  printf '\033]777;awb;prompt;%s\007' "$c"
}
if [[ -n $AWB_CWD && -d $AWB_CWD ]]; then
  cd -- $AWB_CWD || true
fi
"#;

pub const PWSH_PROFILE: &str = r#"$Global:__awb_ready = $true
function prompt {
  $ec = $global:LASTEXITCODE
  if ($null -eq $ec) { $ec = 0 }
  $e = [char]27
  [Console]::Out.Write("$e]777;awb;prompt;$ec$([char]7)")
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}
if ($env:AWB_CWD -and (Test-Path -LiteralPath $env:AWB_CWD)) {
  Set-Location -LiteralPath $env:AWB_CWD
}
"#;

/// How a local shell is started: the program, its arguments, the shell id it
/// reports, and environment it needs beyond the workbench's own.
#[derive(Clone, Debug)]
pub struct ShellLaunch {
    pub file: PathBuf,
    pub args: Vec<String>,
    pub shell: String,
    pub env: Vec<(String, String)>,
}

/// Resolve a detected shell binary for a local terminal. `rc` are the managed
/// startup files. Windows Bash uses the managed native rc file; CMD has none.
pub fn resolve_local_shell(preferred: &str, rc: &ShellFiles, language: &str) -> Result<ShellLaunch, String> {
    let detected = |id: &str| discover().into_iter().find(|shell| shell.id == id);
    if !cfg!(windows) {
        if preferred == "zsh" {
            if let Some(shell) = detected("zsh") {
                return Ok(ShellLaunch {
                    file: shell.path,
                    args: vec!["-i".into()],
                    shell: "zsh".into(),
                    env: vec![("ZDOTDIR".into(), rc.zsh.parent().unwrap_or(Path::new(".")).display().to_string())],
                });
            }
        }
        let file = detected("bash").map(|shell| shell.path).unwrap_or_else(|| PathBuf::from("bash"));
        return Ok(ShellLaunch {
            file,
            args: vec!["--noprofile".into(), "--rcfile".into(), rc.bash.display().to_string(), "-i".into()],
            shell: "bash".into(),
            env: Vec::new(),
        });
    }
    let name: String = match preferred { "bash" => "Git Bash 或本机 Bash".to_string(), "pwsh" => "PowerShell".to_string(), other => other.to_uppercase() };
    let shell = detected(preferred).ok_or_else(|| translate(language, "未检测到 {{0}}，请在设置中选择可用 Shell", &[name.to_string()]))?;
    if preferred == "bash" {
        // The Git root is the folder above `bin`, or above `usr\bin`.
        let binary_directory = shell.path.parent().unwrap_or(Path::new(""));
        let git_root = if binary_directory.file_name().is_some_and(|name| name.to_string_lossy().to_lowercase() == "usr") { binary_directory.parent().unwrap_or(binary_directory) } else { binary_directory };
        let paths: Vec<PathBuf> = [git_root.join("mingw64").join("bin"), git_root.join("usr").join("bin"), git_root.join("bin")].into_iter().filter(|directory| directory.is_dir()).collect();
        // The shell's own folders come first, then the PATH as it stands.
        let mut entries: Vec<String> = paths.iter().map(|directory| directory.to_string_lossy().into_owned()).collect();
        entries.push(std::env::var_os("PATH").map(|value| value.to_string_lossy().into_owned()).unwrap_or_default());
        let joined = entries.join(";");
        let msystem = std::env::var("MSYSTEM").unwrap_or_else(|_| if git_root.join("mingw64").is_dir() { "MINGW64" } else { "MSYS" }.into());
        return Ok(ShellLaunch {
            file: shell.path,
            args: vec!["--noprofile".into(), "--rcfile".into(), rc.bash.display().to_string().replace('\\', "/"), "-i".into()],
            shell: "bash".into(),
            env: vec![("CHERE_INVOKING".into(), "1".into()), ("MSYSTEM".into(), msystem), ("PATH".into(), joined)],
        });
    }
    if preferred == "cmd" {
        return Ok(ShellLaunch { file: shell.path, args: vec!["/Q".into(), "/V:ON".into()], shell: "cmd".into(), env: Vec::new() });
    }
    Ok(ShellLaunch {
        file: shell.path,
        args: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File"].iter().map(|argument| argument.to_string()).chain(std::iter::once(rc.pwsh.display().to_string())).collect(),
        shell: "pwsh".into(),
        env: Vec::new(),
    })
}

/// The shell a host offers for a preferred one: Linux has bash and zsh,
/// Windows has PowerShell and CMD. A preference the host lacks falls back to
/// its default.
pub fn shell_for_host(platform: &str, preferred: &str) -> &'static str {
    if platform == "linux" {
        return if preferred == "zsh" { "zsh" } else { "bash" };
    }
    if preferred == "cmd" { "cmd" } else { "pwsh" }
}

/// The shell a new terminal starts with when the settings name none.
pub fn default_shell(platform: &str) -> &'static str {
    if platform == "linux" { "bash" } else { "pwsh" }
}

/// The managed startup files, under the install data directory.
pub struct ShellFiles {
    pub bash: PathBuf,
    pub pwsh: PathBuf,
    pub zsh: PathBuf,
}

pub fn ensure_shell_files(data: &Path) -> Result<ShellFiles, String> {
    let dir = data.join("shell");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let files = ShellFiles { bash: dir.join("bashrc.sh"), pwsh: dir.join("profile.ps1"), zsh: dir.join(".zshrc") };
    write_if_changed(&files.bash, BASH_RC)?;
    write_if_changed(&files.pwsh, PWSH_PROFILE)?;
    write_if_changed(&files.zsh, ZSH_RC)?;
    Ok(files)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(content) {
        std::fs::write(path, content).map_err(|error| error.to_string())?;
    }
    Ok(())
}
