export async function installDocumentHarness(app, page, accelerate = true) {
  if (accelerate) await page.evaluate(() => {
    const original = window.setTimeout.bind(window)
    window.__autosaveDelays = []
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 120000) window.__autosaveDelays.push(delay)
      return original(callback, delay === 120000 ? 800 : delay, ...args)
    }
  })
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
  await app.evaluate((_electron, command) => { globalThis.__documentMenuCommand = command }, command)
  await page.locator('.file-content').dispatchEvent('contextmenu')
}
