// The workbench window behaves as the Electron build's does: it opens at the
// same size in the color of the saved theme, shows once its page is ready,
// resizes to exactly the size asked for, and minimizes, maximizes and closes
// on request. Drives the running app over the WebView2 debugging port.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { launch, sleep } from './tauri-app.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP workbench window: reads Windows window state, Windows only')
  process.exit(0)
}

// Each theme's sidebar color, as `src/shared/themes.ts` names it.
const SIDEBAR = {
  light: 'rgb(243, 243, 245)',
  dark: 'rgb(19, 20, 23)',
  nord: 'rgb(46, 52, 64)',
}

const started = (theme) => launch({
  prepare: (data) => {
    const db = { settings: { theme }, custom: [], hosts: [], projects: [], sessions: {}, activeTab: {}, workSessions: {}, activeSession: {} }
    fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify(db))
  },
})

const viewport = (page) => page.evaluate(() => [window.innerWidth, window.innerHeight])

// The saved theme is what the page is painted in, from the start: a window
// opened on a dark theme is never light.
for (const [theme, sidebar] of Object.entries(SIDEBAR)) {
  const app = await started(theme)
  try {
    const body = await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    assert.equal(body, sidebar, `the page is painted ${body} on theme ${theme}`)
    const saved = await app.page.evaluate(() => window.awb.getState().then((state) => state.db.settings.theme))
    assert.equal(saved, theme, 'the saved theme was not kept')
  } finally {
    await app.close()
  }
}
console.log('PASS the workbench opens in the color of the saved theme')

const app = await started('light')
try {
  const main = () => app.windows().find((row) => row.title === 'Pello')
  assert.ok(main(), 'the workbench window did not open')
  // Hidden until its page has loaded, so a shown window already has its page.
  assert.equal(main().visible, true, 'the workbench window stayed hidden')
  assert.equal(main().minimized, false, 'the workbench window opened minimized')

  // The size is the page's, 1440 by 900, as the Electron build opens it.
  assert.deepEqual(await viewport(app.page), [1440, 900], `the window opened at ${(await viewport(app.page)).join('x')}`)

  // Resizing sets the page to exactly the size asked for, whatever the scale,
  // and never below 1024 by 680.
  for (const [width, height, gotten] of [[1200, 700, [1200, 700]], [1300, 800, [1300, 800]], [1100, 750, [1100, 750]], [800, 500, [1024, 680]], [1440, 900, [1440, 900]]]) {
    await app.page.evaluate(([w, h]) => window.awb.winResize(w, h), [width, height])
    await sleep(900)
    assert.deepEqual(await viewport(app.page), gotten, `after asking ${width}x${height}`)
  }
  console.log('PASS the window resizes to exactly the size asked for')

  // Maximizing fills the screen; asking again puts it back.
  await app.page.evaluate(() => window.awb.winMax())
  await sleep(1200)
  const screen = await app.page.evaluate(() => [Math.round(screen.availWidth), Math.round(screen.availHeight)])
  assert.deepEqual(await viewport(app.page), screen, 'the window did not fill the screen')
  const before = await viewport(app.page)
  await app.page.evaluate(() => window.awb.winResize(1200, 700))
  await sleep(900)
  assert.deepEqual(await viewport(app.page), [1200, 700], 'resizing a maximized window did not restore it')
  assert.notDeepEqual(before, [1200, 700])

  await app.page.evaluate(() => window.awb.winMax())
  await sleep(1200)
  assert.deepEqual(await viewport(app.page), screen, 'the window did not maximize')
  await app.page.evaluate(() => window.awb.winMax())
  await sleep(1200)
  assert.deepEqual(await viewport(app.page), [1200, 700], 'asking to maximize again did not put the window back')
  console.log('PASS maximizing fills the screen and asking again restores the size')

  await app.page.evaluate(() => window.awb.winMin())
  await sleep(1000)
  assert.equal(main().minimized, true, 'the window did not minimize')
  console.log('PASS the window minimizes on request')

  // Closing ends the app, and it is gone: no window and no process is left.
  await app.page.evaluate(() => window.awb.winClose()).catch(() => {})
  const deadline = Date.now() + 15000
  while (app.app.exitCode === null && Date.now() < deadline) await sleep(250)
  assert.notEqual(app.app.exitCode, null, 'the app did not exit on close')
  assert.equal(app.windows().length, 0, 'a window stayed after the app closed')
  console.log('PASS closing the window ends the app')
} finally {
  await app.close()
}
console.log('PASS the workbench window behaves as the Electron build\'s does')

// Two copies of the app run at once on two data directories, as two installs
// or an install and a check do. Each web view stores under its own data
// directory: sharing WebView2's default, a second copy started with other
// browser arguments fails to create its view and the app ends at startup.
const pair = await Promise.all([
  launch({ port: 9401, prepare: (data) => fs.writeFileSync(path.join(data, 'keep-a'), 'a') }),
  launch({ port: 9402, prepare: (data) => fs.writeFileSync(path.join(data, 'keep-b'), 'b') }),
])
try {
  const stored = await Promise.all(pair.map(async (copy) => {
    // The web view's files exist by now: its page has run.
    const webview = path.join(copy.data, 'webview')
    assert.equal(fs.existsSync(webview), true, 'the web view did not store under its data directory')
    assert.ok(fs.readdirSync(webview).length > 0, 'the web view stored nothing under its data directory')
    return fs.realpathSync.native(webview)
  }))
  assert.notEqual(stored[0], stored[1], 'both copies stored in one web view directory')
  for (const copy of pair) {
    assert.equal(await copy.page.evaluate(() => document.title), 'Pello', 'a copy opened without its page')
  }
  console.log('PASS two copies of the app run at once, each web view in its own data directory')
} finally {
  await Promise.all(pair.map((copy) => copy.close()))
}
