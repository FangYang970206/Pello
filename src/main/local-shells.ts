import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalShell, ShellKind } from '../shared/types'

const execute = promisify(execFile)
const registryRoots = new Set<string>()
const executable = (file: string): boolean => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

export function findLocalShells(platform = process.platform, environment = process.env, extraGitRoots: string[] = []): LocalShell[] {
  const directories = (environment.PATH || environment.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const find = (names: string[], additional: string[] = []) => [...additional, ...directories.flatMap((directory) => names.map((name) => path.join(directory, name)))].find(executable)
  const result: LocalShell[] = []
  const add = (id: ShellKind, label: string, file?: string) => { if (file) result.push({ id, label, path: fs.realpathSync(file) }) }
  if (platform !== 'win32') {
    add('bash', 'bash', find(['bash'], ['/bin/bash', '/usr/bin/bash']))
    add('zsh', 'zsh', find(['zsh'], ['/bin/zsh', '/usr/bin/zsh']))
    return result
  }
  const windows = environment.SystemRoot || environment.WINDIR || 'C:\\Windows'
  const programs = [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter((value): value is string => !!value)
  add('pwsh', 'PowerShell', find(['pwsh.exe'], programs.map((root) => path.join(root, 'PowerShell', '7', 'pwsh.exe'))) || find(['powershell.exe'], [path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]))
  add('cmd', 'CMD', find(['cmd.exe'], [environment.ComSpec || path.join(windows, 'System32', 'cmd.exe')]))
  const gitRoots = [...extraGitRoots, ...programs.map((root) => path.join(root, 'Git')),
    ...(environment.LOCALAPPDATA ? [path.join(environment.LOCALAPPDATA, 'Programs', 'Git'), path.join(environment.LOCALAPPDATA, 'Git')] : []),
    ...directories.filter((directory) => executable(path.join(directory, 'git.exe'))).map((directory) => path.dirname(directory))]
  const gitBash = gitRoots.flatMap((root) => [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]).find(executable)
  // System32 bash.exe starts WSL and cannot accept the managed Windows rc file.
  const system = path.resolve(windows).toLowerCase() + path.sep
  const nativeBash = directories.map((directory) => path.join(directory, 'bash.exe')).find((file) => !path.resolve(file).toLowerCase().startsWith(system) && executable(file))
  add('bash', gitBash ? 'Git Bash' : 'bash', gitBash || nativeBash)
  return result
}

export async function discoverLocalShells(): Promise<LocalShell[]> {
  let shells = findLocalShells(process.platform, process.env, [...registryRoots])
  if (process.platform !== 'win32' || shells.some((shell) => shell.id === 'bash')) return shells
  const results = await Promise.allSettled(['HKCU', 'HKLM'].map((hive) => execute('reg.exe', ['query', `${hive}\\Software\\GitForWindows`, '/v', 'InstallPath'], { timeout: 2000, windowsHide: true })))
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const value = /InstallPath\s+REG_SZ\s+([^\r\n]+)/i.exec(result.value.stdout)?.[1].trim()
    if (value && path.isAbsolute(value)) registryRoots.add(value)
  }
  shells = findLocalShells(process.platform, process.env, [...registryRoots])
  return shells
}

export function localShell(kind: ShellKind): LocalShell | undefined { return findLocalShells(process.platform, process.env, [...registryRoots]).find((shell) => shell.id === kind) }
