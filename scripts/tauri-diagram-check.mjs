// Diagrams are drawn in a hidden window of the app, as the Electron build
// draws them: a real page, Mermaid's strict mode, and no workbench API in
// that window. Drives the running app over the WebView2 debugging port.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.env.AWB_APP_EXE || path.join(root, 'src-tauri/target/debug/pello.exe')
// Measured on this WebView2: 9333 through 9620 open within a second; 9630 and
// above never listen, so the range stays below what was measured.
const port = 9333 + Math.floor(Math.random() * 267)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-diagram-check-'))

// The top-level windows a process owns, as Windows sees them.
function nativeWindows(pid) {
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
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] List(uint want) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want) {
        var sb = new StringBuilder(200); GetWindowText(h, sb, 200);
        rows.Add((IsWindowVisible(h) ? "visible|" : "hidden|") + sb);
      }
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
}
"@
[PelloWindowLook]::List([uint32]${pid})
`
  const output = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' })
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('|')).map((line) => ({ visible: line.startsWith('visible|'), title: line.slice(line.indexOf('|') + 1) }))
}

if (process.platform !== 'win32') {
  console.log('SKIP hidden diagram window: drives WebView2, Windows only')
  process.exit(0)
}
const app = spawn(executable, [], {
  cwd: root,
  env: { ...process.env, AWB_USER_DATA: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let browser
try {
  let version = null
  for (let tries = 0; tries < 60 && !version; tries++) {
    await sleep(500)
    version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json()).catch(() => null)
  }
  assert.ok(version, 'the app did not open its debugging port')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const main = () => browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith('http://tauri.localhost'))
  let page = null
  for (let tries = 0; tries < 40 && !page; tries++) { await sleep(250); page = main() }
  assert.ok(page, 'the workbench window did not open')
  await page.waitForFunction(() => typeof window.awb?.renderMermaid === 'function', null, { timeout: 20000 })

  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())).map((target) => target.url)

  // A diagram becomes an SVG that holds the diagram's own text.
  const started = Date.now()
  const first = await page.evaluate(() => window.awb.renderMermaid('flowchart TD\nA[Hello]-->B[World]'))
  const firstMs = Date.now() - started
  assert.ok(first.startsWith('<svg'), `not an SVG: ${first.slice(0, 120)}`)
  assert.ok(first.includes('Hello') && first.includes('World'), 'the diagram text is missing')
  assert.ok(!first.includes('window.awb') && !first.includes('__TAURI'), 'the workbench bridge must not be in the result')
  console.log(`PASS a diagram is drawn as SVG in ${firstMs} ms`)

  // Strict mode sanitizes: markup in a label may stay, an event handler on it may not.
  const strict = await page.evaluate(() => window.awb.renderMermaid('flowchart TD\nA["<img src=x onerror=alert(1)>"]'))
  assert.ok(strict.includes('<svg'), 'the strict diagram is not an SVG')
  assert.ok(!/<img[^>]*\son[a-z]+\s*=/i.test(strict), `strict mode kept an event handler: ${strict.slice(-300)}`)
  assert.ok(!strict.includes('alert(1)'), `strict mode kept the handler's script: ${strict.slice(-300)}`)
  assert.ok(!/<script/i.test(strict), 'strict mode kept a script element')
  console.log('PASS strict mode strips event handlers from markup in a label')

  // A diagram Mermaid rejects is an error, and the window still draws after it.
  const broken = await page.evaluate(() => window.awb.renderMermaid('flowchart TD\nA -- missing node').then(() => '', (error) => String(error)))
  assert.ok(broken.length > 0, 'a diagram that cannot be parsed must fail')
  const after = await page.evaluate(() => window.awb.renderMermaid('pie\n"one": 1\n"two": 2'))
  assert.ok(after.includes('<svg') && after.includes('one'), 'no diagram was drawn after a failure')
  console.log('PASS a rejected diagram fails and the next one is drawn')

  // The same diagram is answered from the cache without asking the page.
  const again = await page.evaluate(() => window.awb.renderMermaid('flowchart TD\nA[Hello]-->B[World]'))
  assert.equal(again, first)
  console.log('PASS the same diagram is returned from the cache')

  // The drawing window is hidden, loads only the bundled page, and has no
  // workbench command: its one command is to hand back what it drew.
  const drawing = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('diagram-renderer'))
  assert.ok(drawing, `no drawing window among ${(await targets()).join(', ')}`)
  assert.ok(drawing.url().startsWith('http://tauri.localhost/diagram-renderer.html'), `the drawing window is not on the bundled page: ${drawing.url()}`)
  // A web view reports `visible` for a host window that is not shown, so the
  // window's own state is what tells whether it is on screen.
  const native = nativeWindows(app.pid).find((row) => row.title === 'Pello diagram renderer')
  assert.ok(native, `no drawing window among the app's windows: ${(await nativeWindows(app.pid)).map((row) => row.title).join(', ')}`)
  assert.equal(native.visible, false, 'the drawing window is on screen')
  // `awb` is refused by the capability, and so is a built-in command the
  // drawing window was not given. The same call is made in the main window,
  // where it is allowed: a call that is wrong for both would prove nothing.
  // `plugin:os` is refused only because no plugin is installed.
  const probe = async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const outcome = {}
    for (const [name, command, args] of [
      ['workbench', 'awb', { channel: 'db:get', args: [] }],
      ['scale', 'plugin:window|scale_factor', { label: 'main' }],
      ['result', 'diagram_result', { id: 'nobody-waits-for-this', svg: '<svg></svg>' }],
    ]) {
      outcome[name] = await invoke(command, args).then((value) => `ok:${JSON.stringify(value)}`.slice(0, 80), (error) => `denied:${String(error)}`.slice(0, 80))
    }
    return outcome
  }
  const inPage = await drawing.evaluate(probe)
  const inMain = await page.evaluate(probe)
  assert.match(inPage.workbench, /not allowed/i, 'the drawing window reached the workbench')
  assert.match(inPage.scale, /not allowed/i, 'the drawing window was allowed a built-in command it was not given')
  assert.match(inPage.result, /ok|no diagram waits/, 'its own command should be reachable')
  assert.match(inMain.scale, /^ok:/, `the call that must be refused in the drawing window does not work in the main window: ${inMain.scale}`)
  console.log(`PASS the drawing window is hidden and may only hand back a drawing (${inPage.workbench}; ${inPage.scale})`)

  // Nowhere else may be loaded from that window. The probe that matters is
  // the app's own other page: without the guard the window goes there and
  // loads the whole workbench. A site outside is asked for too, though this
  // machine cannot show whether it is the guard that stops it.
  const leaves = async (url) => {
    const attempt = drawing.evaluate((target) => { window.location.href = target }, url).catch((error) => `evaluate failed: ${String(error).slice(0, 60)}`)
    await Promise.race([attempt, sleep(2000)])
    await sleep(1500)
    const pages = browser.contexts().flatMap((context) => context.pages())
    const itself = pages.find((candidate) => candidate.url().includes('diagram-renderer'))
    const stayed = itself ? await itself.evaluate(() => location.pathname === '/diagram-renderer.html' && typeof window.renderMermaid === 'function').catch(() => false) : false
    return { stayed, urls: (await targets()).join(' | ') }
  }
  for (const url of ['http://tauri.localhost/', 'http://tauri.localhost/index.html', 'https://example.com/']) {
    const outcome = await leaves(url)
    assert.ok(outcome.stayed, `the drawing window left its page for ${url}: ${outcome.urls}`)
  }
  assert.equal((await targets()).filter((url) => url.includes('diagram-renderer')).length, 1, 'a second drawing page appeared')
  assert.ok((await page.evaluate(() => document.title)) === 'Pello', 'the workbench window changed')
  console.log('PASS the drawing window cannot leave its page')
  const afterNavigation = await page.evaluate(() => window.awb.renderMermaid('graph LR\nX --> Y'))
  assert.ok(afterNavigation.includes('<svg'), 'no diagram was drawn after a refused navigation')
} finally {
  if (browser) await browser.close().catch(() => {})
  app.kill()
  await sleep(500)
  fs.rmSync(data, { recursive: true, force: true })
}
console.log('PASS diagrams are drawn in a hidden, isolated window of the app')
