import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright'
import { connectWebKitPage } from './webkit-page.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let displayProcess

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function ensureDisplay() {
  if (process.env.DISPLAY) return
  const display = ':97'
  displayProcess = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' })
  process.env.DISPLAY = display
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`
  for (let attempt = 0; attempt < 50 && !fs.existsSync(socket); attempt++) await new Promise((resolve) => setTimeout(resolve, 40))
  if (!fs.existsSync(socket)) throw new Error('Xvfb did not create a display')
}

function httpText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.setTimeout(1000, () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true) })
    socket.on('error', () => resolve(false))
  })
}

async function ensureDevServer() {
  if (await portOpen(1420)) return
  const child = spawn('npm', ['run', 'dev:tauri:web'], { cwd: root, stdio: 'ignore', detached: true })
  child.unref()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await portOpen(1420)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The Tauri debug webview loads http://127.0.0.1:1420, and that dev server did not start')
}

async function waitForInspector(port, child) {
  const deadline = Date.now() + 20000
  let last = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Tauri exited ${child.exitCode} before the webview opened: ${last}`)
    try {
      const result = await httpText(`http://127.0.0.1:${port}/`)
      last = `${result.status} ${result.body.slice(0, 180)}`
      if (result.status === 200 && result.body.includes('Inspectable targets')) return
    } catch (error) {
      last = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`WebKit inspector did not open on 127.0.0.1:${port}: ${last}`)
}

/**
 * Launch the workbench. The default is the existing Electron app.
 * `AWB_SHELL=tauri` starts the Tauri binary and drives its webview: on Windows
 * through the WebView2 debugging port, elsewhere on a virtual display through
 * the WebKit inspector socket.
 */
export async function launchWorkbench({ args = ['.'], env = process.env, cwd, scale = 1 } = {}) {
  if (process.env.AWB_SHELL !== 'tauri') {
    const app = await electron.launch({ args, env, cwd })
    app.shell = 'electron'
    return app
  }
  if (process.platform === 'win32') return launchWebView2({ env, cwd })
  await ensureDisplay()
  await ensureDevServer()
  const binary = process.env.AWB_TAURI_BIN || path.join(root, 'src-tauri/target/debug/pello')
  if (!fs.existsSync(binary)) throw new Error(`Tauri binary is missing: ${binary}`)
  const port = await freePort()
  const menuFile = path.join(os.tmpdir(), `pello-menu-${process.pid}-${port}.txt`)
  fs.writeFileSync(menuFile, '')
  const logs = []
  // Electron keeps localStorage in the isolated user-data directory. WebKitGTK
  // uses XDG paths, so point those at the same directory for this launch.
  const isolated = {}
  if (env.AWB_USER_DATA && !env.XDG_DATA_HOME) {
    const webkit = path.join(env.AWB_USER_DATA, 'webkit')
    fs.mkdirSync(path.join(webkit, 'data'), { recursive: true })
    fs.mkdirSync(path.join(webkit, 'cache'), { recursive: true })
    isolated.XDG_DATA_HOME = path.join(webkit, 'data')
    isolated.XDG_CACHE_HOME = path.join(webkit, 'cache')
  }
  const child = spawn(binary, [], {
    cwd: cwd || root,
    env: {
      ...env,
      ...isolated,
      DISPLAY: process.env.DISPLAY,
      WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}`,
      WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      WEBKIT_DISABLE_COMPOSITING_MODE: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
      GDK_BACKEND: 'x11',
      GDK_SCALE: '1',
      GDK_DPI_SCALE: String(scale),
      AWB_MENU_FILE: menuFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => logs.push(String(chunk)))
  child.stderr.on('data', (chunk) => logs.push(String(chunk)))
  let page
  try {
    await waitForInspector(port, child)
    page = await connectWebKitPage(port)
  } catch (error) {
    child.kill('SIGTERM')
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${logs.join('').slice(-2000)}`, { cause: error })
  }
  page.setDefaultTimeout(15000)
  const app = {
    shell: 'tauri',
    menuFile,
    async firstWindow() { return page },
    windows() { return [page] },
    process() { return child },
    async evaluate() { throw new Error('Tauri webview has no Electron main process') },
    waitForEvent(name) {
      if (name !== 'close') throw new Error(`Unsupported Tauri event ${name}`)
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve()
        else child.once('exit', () => resolve())
      })
    },
    async close() {
      try { await page.evaluate(() => window.awb.winClose()) } catch { /* The page can already be gone. */ }
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) { resolve(); return }
        const timer = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 8000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
      try { page.close() } catch { /* The inspector socket closes with the process. */ }
      fs.rmSync(menuFile, { force: true })
    },
  }
  return app
}

// Measured on this WebView2: 9333 through 9620 open within a second; 9630 and
// above never listen, so the range stays below what was measured. The port is
// drawn for each start and never shared: a second app on the port of one that
// has not finished exiting attaches to the old one, and reads its data.
const nextDebugPort = () => 9333 + Math.floor(Math.random() * 267)

async function launchWebView2({ env, cwd }) {
  const binary = process.env.AWB_TAURI_BIN || path.join(root, 'src-tauri/target/debug/pello.exe')
  if (!fs.existsSync(binary)) throw new Error(`Tauri binary is missing: ${binary}. Build it with: npx tauri build --debug --no-bundle`)
  const port = nextDebugPort()
  const menuFile = path.join(os.tmpdir(), `pello-menu-${process.pid}-${port}.txt`)
  fs.writeFileSync(menuFile, '')
  const child = spawn(binary, [], {
    cwd: cwd || root,
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, AWB_MENU_FILE: menuFile },
    stdio: 'ignore',
  })
  let page
  let browser
  try {
    let open = false
    for (let tries = 0; tries < 60 && !open; tries++) {
      if (child.exitCode !== null) throw new Error(`Tauri exited ${child.exitCode} before the webview opened`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      open = await httpText(`http://127.0.0.1:${port}/json/version`).then((result) => result.status === 200, () => false)
    }
    if (!open) throw new Error(`WebView2 did not open its debugging port on 127.0.0.1:${port}`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    for (let tries = 0; tries < 40 && !page; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('http://tauri.localhost') && !candidate.url().includes('diagram-renderer'))
    }
    if (!page) throw new Error('The workbench window did not open')
    await page.waitForFunction(() => typeof window.awb?.renderMermaid === 'function' && document.documentElement.getAttribute('data-theme') !== null, null, { timeout: 20000 })
    page.setDefaultTimeout(15000)
  } catch (error) {
    if (browser) await browser.close().catch(() => {})
    if (child.exitCode === null) child.kill()
    fs.rmSync(menuFile, { force: true })
    throw error
  }
  // Whether the app is gone is asked of the system, not of Node: after the
  // debugging connection is closed, Node can hold the exit notice back.
  const alive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  return {
    shell: 'tauri',
    menuFile,
    async firstWindow() { return page },
    windows() { return browser.contexts().flatMap((context) => context.pages()).filter((candidate) => !candidate.url().includes('diagram-renderer')) },
    process() { return child },
    async evaluate() { throw new Error('Tauri webview has no Electron main process') },
    waitForEvent(name) {
      if (name !== 'close') throw new Error(`Unsupported Tauri event ${name}`)
      return new Promise((resolve) => {
        const check = () => { if (!alive() || child.exitCode !== null || child.signalCode) resolve(); else setTimeout(check, 100) }
        check()
      })
    },
    async close() {
      try { await page.evaluate(() => window.awb.winClose()) } catch { /* The page can already be gone. */ }
      const deadline = Date.now() + 8000
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      if (alive()) child.kill()
      const last = Date.now() + 10000
      while (alive() && Date.now() < last) await new Promise((resolve) => setTimeout(resolve, 100))
      await browser.close().catch(() => {})
      fs.rmSync(menuFile, { force: true })
      if (alive()) throw new Error(`The app (pid ${child.pid}) did not exit after it was closed`)
    },
  }
}

export function stopDisplay() {
  displayProcess?.kill('SIGTERM')
}
