//! Local shell discovery. Linux looks up bash and zsh; Windows names are recognized
//! when this crate is built there. Managed startup files stay under the install data directory.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct LocalShell {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
}

pub fn discover() -> Vec<LocalShell> {
    let mut shells = Vec::new();
    if cfg!(windows) {
        if let Some(path) = which("pwsh.exe").or_else(|| which("powershell.exe")) {
            shells.push(LocalShell { id: "pwsh".into(), label: "PowerShell".into(), path });
        }
        if let Some(path) = which("cmd.exe") {
            shells.push(LocalShell { id: "cmd".into(), label: "CMD".into(), path });
        }
        return shells;
    }
    if let Some(path) = which("bash").or_else(|| existing("/bin/bash")).or_else(|| existing("/usr/bin/bash")) {
        shells.push(LocalShell { id: "bash".into(), label: "bash".into(), path });
    }
    if let Some(path) = which("zsh").or_else(|| existing("/bin/zsh")).or_else(|| existing("/usr/bin/zsh")) {
        shells.push(LocalShell { id: "zsh".into(), label: "zsh".into(), path });
    }
    shells
}

pub fn command_exists(name: &str) -> bool {
    which(name).is_some()
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(name);
        if is_executable(&candidate) { return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate)) }
    }
    None
}

fn existing(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    is_executable(&path).then(|| std::fs::canonicalize(&path).unwrap_or(path))
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

pub fn ensure_shell_files(data: &Path) -> Result<(PathBuf, PathBuf), String> {
    let dir = data.join("shell");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let bash = dir.join("bashrc.sh");
    let zsh = dir.join(".zshrc");
    write_if_changed(&bash, BASH_RC)?;
    write_if_changed(&zsh, ZSH_RC)?;
    Ok((bash, zsh))
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(content) {
        std::fs::write(path, content).map_err(|error| error.to_string())?;
    }
    Ok(())
}
