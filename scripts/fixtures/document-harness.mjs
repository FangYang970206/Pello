import fs from 'node:fs'

export async function installDocumentHarness(app, page, accelerate = true) {
  if (accelerate) await page.evaluate(() => {
    const original = window.setTimeout.bind(window)
    window.__autosaveDelays = []
    window.__autosaveDelay = 800
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 120000) window.__autosaveDelays.push(delay)
      return original(callback, delay === 120000 ? window.__autosaveDelay : delay, ...args)
    }
  })
  if (app.menuFile) return
  await app.evaluate(({ Menu }) => {
    if (globalThis.__documentMenuInstalled) return
    globalThis.__documentMenuInstalled = true
    const original = Menu.prototype.popup
    Menu.prototype.popup = function (options) {
      const command = globalThis.__documentMenuCommand
      if (!command) return original.call(this, options)
      globalThis.__documentMenuCommand = null
      const item = this.getMenuItemById(command)
      if (!item || !item.enabled) throw new Error(`Missing or disabled document command: ${command}`)
      item.click()
      options?.callback?.()
    }
  })
}

export async function documentCommand(app, page, command) {
  if (app.menuFile) fs.writeFileSync(app.menuFile, command)
  else await app.evaluate((_electron, command) => { globalThis.__documentMenuCommand = command }, command)
  await page.locator('.file-content').dispatchEvent('contextmenu')
  if (!app.menuFile) return
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (fs.readFileSync(app.menuFile, 'utf8').trim() !== command) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`document command was not consumed: ${command}`)
}
