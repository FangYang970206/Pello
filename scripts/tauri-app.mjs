// Starts the built Tauri app for a regression and hands back its workbench
// page, as the Electron scripts start the Electron build with `_electron`.
//
// The app is driven through its own bridge, `window.awb`, the way the workbench
// does; nothing reaches into the process. It is the built app with the
// frontend embedded: a plain debug build looks for the development server.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.env.AWB_APP_EXE || path.join(root, 'src-tauri/target/debug/pello.exe')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A debugging port for one run of the app. Measured on this WebView2: 9333
// through 9620 open within a second; 9630 and above never listen, so the range
// stays below what was measured. It is drawn for each start, never shared:
// a second app on the port of one that has not finished exiting attaches to
// the old one, and reads its windows and its data.
const nextPort = () => 9333 + Math.floor(Math.random() * 267)

// The top-level windows the app owns, as Windows sees them. A web view reports
// `visible` for a host window that is not shown, so this is what tells whether
// a window is on screen.
export function nativeWindows(pid) {
  assert.equal(process.platform, 'win32', 'native window state is read on Windows only')
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PelloWindowLook {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] List(uint want) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want) {
        var sb = new StringBuilder(200); GetWindowText(h, sb, 200);
        rows.Add((IsWindowVisible(h) ? "visible|" : "hidden|") + (IsIconic(h) ? "minimized|" : "normal|") + sb);
      }
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
"@
[PelloWindowLook]::List([uint32]${pid})
`
  const output = spawnSyncPowerShell(script)
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('|')).map((line) => {
    const [visibility, state, ...title] = line.split('|')
    return { visible: visibility === 'visible', minimized: state === 'minimized', title: title.join('|') }
  })
}

function spawnSyncPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' })
}

// Starts the app on fresh data and waits for its workbench page. `prepare`
// seeds that data first. `port` picks the debugging port instead of drawing
// one, for checks that run two apps at once. `close` ends the app and removes
// the data.
export async function launch(options = {}) {
  const port = options.port ?? nextPort()
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-tauri-check-'))
  // `prepare` may put files in the data directory before the app reads it,
  // to start the app on saved settings rather than on defaults.
  if (options.prepare) await options.prepare(data)
  const app = spawn(executable, [], {
    cwd: root,
    env: { ...process.env, ...options.env, AWB_USER_DATA: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // What the app says before its window exists, such as the reason it ended.
  // It is kept for a start that fails, and dropped with the app otherwise.
  let early = ''
  app.stderr.on('data', (chunk) => { early = (early + String(chunk)).slice(-4000) })
  let browser = null
  const close = async () => {
    if (browser) await browser.close().catch(() => {})
    // Whether the app is gone is asked of the system, not of Node: after the
    // debugging connection is closed, Node can hold the exit notice back for
    // longer than a check can wait, while the process itself has ended.
    const alive = () => { try { process.kill(app.pid, 0); return true } catch { return false } }
    if (app.exitCode === null && alive()) app.kill()
    const deadline = Date.now() + 15000
    while (alive() && Date.now() < deadline) await sleep(100)
    // The web view is a browser of its own that outlives the app by a moment
    // and holds the files it stores under the data directory until it is gone,
    // so removing them is retried for as long.
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })
    assert.ok(!alive() || app.exitCode !== null, `the app (pid ${app.pid}) did not exit after it was ended`)
  }
  try {
    let version = null
    for (let tries = 0; tries < 60 && !version; tries++) {
      await sleep(500)
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json()).catch(() => null)
    }
    assert.ok(version, `the app did not open its debugging port${early.trim() ? `:\n${early.trim()}` : ''}`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const pages = () => browser.contexts().flatMap((context) => context.pages())
    let page = null
    for (let tries = 0; tries < 40 && !page; tries++) {
      await sleep(250)
      page = pages().find((candidate) => candidate.url().startsWith('http://tauri.localhost') && !candidate.url().includes('diagram-renderer'))
    }
    assert.ok(page, 'the workbench window did not open')
    await page.waitForFunction(() => typeof window.awb?.renderMermaid === 'function', null, { timeout: 20000 })
    // The page sets its theme once it has the saved settings; reading colors
    // before that shows the theme it opened with, not the saved one. The page
    // is written with `data-theme="light"` and names the saved theme in its
    // palette, so it is the palette that tells the settings have arrived.
    await page.waitForFunction(() => document.documentElement.getAttribute('data-palette') !== null && document.body !== null, null, { timeout: 20000 })
    return { app, page, browser, data, port, close, pages: () => pages(), windows: () => nativeWindows(app.pid) }
  } catch (error) {
    await close()
    throw error
  }
}
