import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/local-shells.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { findLocalShells } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-local-shells-'))
const stub = (relative) => { const file = path.join(data, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(process.execPath, file); return file }
const windows = path.join(data, 'Windows')
stub('Windows/System32/bash.exe')
stub('Windows/System32/cmd.exe')
stub('Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
const environment = { SystemRoot: windows, PATH: path.join(windows, 'System32') }
assert.deepEqual(findLocalShells('win32', environment).map((item) => item.id), ['pwsh', 'cmd'], 'The legacy WSL bash launcher must be excluded')
const bash = stub('自定义 Git/bin/bash.exe')
stub('自定义 Git/cmd/git.exe')
environment.PATH += `;${path.join(data, '自定义 Git/cmd')}`
assert.equal(findLocalShells('win32', environment).find((item) => item.id === 'bash')?.path, fs.realpathSync(bash))
assert.equal(findLocalShells('win32', environment).find((item) => item.id === 'bash')?.label, 'Git Bash')
environment.PATH = path.join(windows, 'System32')
assert.equal(findLocalShells('win32', environment, [path.join(data, '自定义 Git')]).find((item) => item.id === 'bash')?.path, fs.realpathSync(bash))
fs.unlinkSync(bash)
assert.equal(findLocalShells('win32', environment, [path.join(data, '自定义 Git')]).some((item) => item.id === 'bash'), false)
console.log('PASS local Shell detection handles custom Git paths, missing binaries and WSL launcher exclusion')

const project = path.join(data, '中文 项目')
const home = path.join(data, 'isolated-home')
fs.mkdirSync(project); fs.mkdirSync(home)
fs.writeFileSync(path.join(home, '.bashrc'), 'export AWB_BASHRC_FIXTURE=用户配置已加载\n')
fs.writeFileSync(path.join(project, '中文 文件.txt'), '中文内容\n')
const initialShell = process.platform === 'win32' ? 'pwsh' : 'bash'
fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
  settings: { defShell: initialShell, defAgent: 'shell', restore: true, confirmKill: false, theme: 'dark' },
  projects: [{ id: 'p', name: 'Shell regression', host: 'local', path: project, agent: 'shell' }],
  sessions: { p: [{ id: 'original', kind: 'shell', shell: initialShell }] }
}))
const env = { ...process.env, AWB_USER_DATA: data, HOME: home }
delete env.ELECTRON_RUN_AS_NODE
let app
const launch = async () => { app = await electron.launch({ args: [root], cwd: root, env }); const page = await app.firstWindow(); page.setDefaultTimeout(15000); return page }
try {
  let page = await launch()
  await page.waitForFunction(() => window.__awbBuffer?.('original')?.includes('>') || window.__awbBuffer?.('original')?.includes('$'))
  await page.evaluate(() => { window.__originalTerminal = document.querySelector('.termhost .xterm') })
  const detected = await page.evaluate(() => window.awb.localShells())
  assert.ok(detected.some((item) => item.id === initialShell))
  const nativeBash = detected.find((item) => item.id === 'bash')
  assert.ok(nativeBash, 'Native Bash is required for this behavioral acceptance test')
  console.log(`Detected native Bash: ${nativeBash.path}`)
  await page.click('[data-a=settings]')
  const select = page.getByLabel('默认 Shell', { exact: true })
  await page.waitForFunction(() => !document.querySelector('[aria-label="默认 Shell"]').disabled)
  assert.ok((await select.locator('option').allTextContents()).some((value) => value === nativeBash.label))
  await select.selectOption('bash')
  await page.waitForFunction(async () => (await window.awb.getState()).db.settings.defShell === 'bash')
  await page.click('[data-a=back]')
  assert.equal(await page.evaluate(() => window.__originalTerminal === document.querySelector('.termhost .xterm')), true)
  await page.evaluate(() => { window.__shellStates = {}; window.awb.onPty((event) => { if (event.type === 'state') window.__shellStates[event.id] = event }) })
  await page.locator('.addtab[data-a=newterm]').locator('..').hover()
  await page.click('.addtab[data-a=newterm]')
  const bashOption = page.getByRole('radio', { name: nativeBash.label, exact: true })
  if (detected.length > 1) { await bashOption.waitFor(); assert.equal(await bashOption.getAttribute('aria-checked'), 'true') }
  await page.click('[data-a=nt-ok]')
  await page.waitForSelector('#modal .dlg', { state: 'hidden' })
  const id = await page.locator('.tab.on [data-a=tab]').getAttribute('data-id')
  assert.notEqual(id, 'original')
  await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('$'), id)
  await page.evaluate((id) => window.awb.ptyWrite(id, `printf '\\nAWB_BASH_OK:%s:%s\\n' "$BASH_VERSION" "$AWB_BASHRC_FIXTURE"; pwd; cat '中文 文件.txt'; command -v ls; printf '\\nAWB_PATH_DONE:%s\\n' "$?"\r`), id)
  await page.waitForFunction((id) => /AWB_BASH_OK:[0-9].*:用户配置已加载/.test(window.__awbBuffer(id)) && window.__awbBuffer(id).includes('中文内容') && window.__awbBuffer(id).includes('AWB_PATH_DONE:0') && window.__shellStates[id]?.inputReady, id)
  const contents = await page.evaluate((id) => window.__awbBuffer(id), id)
  assert.ok(contents.includes('中文 项目'))
  assert.ok(contents.includes('/usr/bin/ls') || contents.includes('/bin/ls'), contents)
  const shellInfo = await page.evaluate(async (id) => (await window.awb.getState()).db.sessions.p.find((item) => item.id === id), id)
  assert.equal(shellInfo.shell, 'bash')
  const reference = await page.evaluate(() => window.awb.treeReference('p', '中文 文件.txt', 'shell', 'bash'))
  assert.equal(reference.includes('\\'), false)
  await page.evaluate(({ id, reference }) => window.awb.ptyWrite(id, `cat ${reference}\r`), { id, reference })
  await page.waitForFunction((id) => window.__awbBuffer(id).split('中文内容').length >= 3, id)
  const shots = path.join(root, 'output/playwright/local-shells')
  fs.mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: path.join(shots, 'git-bash.png') })
  await page.click('[data-a=settings]')
  await page.getByLabel('默认 Shell', { exact: true }).selectOption(initialShell)
  await page.click('[data-a=back]')
  assert.ok((await page.evaluate((id) => window.__awbBuffer(id), id)).includes('AWB_BASH_OK:'))
  await page.click('[data-a=settings]')
  await page.getByLabel('默认 Shell', { exact: true }).selectOption('bash')
  await page.waitForFunction(async () => (await window.awb.getState()).db.settings.defShell === 'bash')
  await page.screenshot({ path: path.join(shots, 'shell-settings.png') })
  await app.close(); app = undefined
  page = await launch()
  await page.waitForFunction((id) => window.__awbBuffer?.(id)?.includes('$'), id)
  await page.evaluate((id) => window.awb.ptyWrite(id, 'printf "\\nAWB_RESTORED:%s\\n" "$BASH_VERSION"\r'), id)
  await page.waitForFunction((id) => /AWB_RESTORED:[0-9]/.test(window.__awbBuffer(id)), id)
  assert.equal(await page.evaluate(async () => (await window.awb.getState()).db.settings.defShell), 'bash')
  console.log('PASS default Git Bash starts internally, loads user bashrc, handles Unicode paths and survives default changes and restart')
  await app.evaluate(({ ipcMain }, shells) => {
    globalThis.__shellDetectionMode = 'error'
    ipcMain.removeHandler('shells:local')
    ipcMain.handle('shells:local', () => {
      if (globalThis.__shellDetectionMode === 'error') throw new Error('Shell 检测测试失败')
      return globalThis.__shellDetectionMode === 'missing' ? shells.filter((item) => item.id !== 'bash') : shells
    })
  }, detected)
  await page.click('[data-a=settings]')
  await page.getByText(/Shell 检测测试失败/).waitFor()
  assert.equal(await page.getByLabel('默认 Shell', { exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate(async () => (await window.awb.getState()).db.settings.defShell), 'bash')
  await app.evaluate(() => { globalThis.__shellDetectionMode = 'missing' })
  await page.getByRole('button', { name: '重新检测', exact: true }).click()
  await page.getByRole('option', { name: 'bash（未检测到）', exact: true }).waitFor({ state: 'attached' })
  assert.equal(await page.getByLabel('默认 Shell', { exact: true }).inputValue(), 'bash')
  await app.evaluate(() => { globalThis.__shellDetectionMode = 'available' })
  await page.getByRole('button', { name: '重新检测', exact: true }).click()
  await page.getByRole('option', { name: nativeBash.label, exact: true }).waitFor({ state: 'attached' })
  await page.click('[data-a=back]')
  await app.evaluate(() => { globalThis.__shellDetectionMode = 'missing' })
  if (detected.length > 1) {
    await page.locator('.addtab[data-a=newterm]').locator('..').hover()
    await page.click('.addtab[data-a=newterm]')
    await page.getByRole('alert').filter({ hasText: '未检测到 bash' }).waitFor()
    assert.equal(await page.locator('[data-a=nt-ok]').isDisabled(), true)
    await page.getByRole('radio', { name: detected.find((item) => item.id !== 'bash').label, exact: true }).click()
    assert.equal(await page.locator('[data-a=nt-ok]').isDisabled(), false)
    await page.keyboard.press('Escape')
  }
  console.log('PASS detection failures retry without resetting the saved Shell; unavailable defaults require an explicit available choice')
} finally {
  if (app) await app.close()
}
