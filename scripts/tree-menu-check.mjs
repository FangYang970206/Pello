// The menu of a file tree's entry, item for item as the Electron build builds
// it, and what its items do on the built app: a copied path is on the
// clipboard, a file is shown in its folder and opens with what the system
// opens it with, an editor is offered when one is installed, and a file is
// saved under another name only where that name is free. Nothing is opened
// for real here: a program stands in for the desktop and writes down what it
// was asked to open, as a check must not leave windows on the user's desktop.
// The menu itself is the native one: the shell writes the template it was
// given beside the launcher's menu file and takes the choice from that file
// instead of popping it up, so a check reads what the desktop would have shown.
// Drives the running app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWorkbench } from './fixtures/launch-workbench.mjs'

const root = path.resolve('.')
const slashes = (value) => String(value).replaceAll('\\', '/')
const failures = []
const check = async (name, run) => { try { await run(); console.log('PASS ' + name) } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message) } }

async function start(extra = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-tree-menu-'))
  const project = path.join(data, 'project')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'note.txt'), 'a note to be saved elsewhere\n')
  fs.writeFileSync(path.join(data, 'workbench.json'), JSON.stringify({
    settings: { autoCheckUpdates: false, restore: false, confirmKill: false },
    projects: [{ id: 'p', name: 'Tree menu', host: 'local', path: project, agent: 'shell' }],
  }))
  // The desktop's stand-in: one line per thing opened, instead of a window.
  const openLog = path.join(data, 'open.log')
  const openBin = path.join(data, 'open-bin.cmd')
  fs.writeFileSync(openBin, '@echo off\r\necho %1>>"' + openLog + '"\r\nexit /b 0\r\n')
  const clipboard = path.join(data, 'clipboard.txt')
  const env = { ...process.env, AWB_USER_DATA: data, AWB_OPEN_BIN: openBin, AWB_OPEN_LOG: openLog, AWB_CLIPBOARD_FILE: clipboard, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await launchWorkbench({ args: ['.'], env, cwd: root })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // What the native menu was given: the template the shell wrote, read after
  // the page asked for the menu and nothing was chosen.
  const menu = async (rel, directory) => {
    const menuFile = app.menuFile
    await fs.promises.rm(menuFile + '.json', { force: true })
    await fs.promises.rm(menuFile, { force: true })
    const chosen = await page.evaluate(([rel, directory]) => window.awb.treeMenu('p', rel, directory), [rel, directory])
    assert.equal(chosen, null, 'nothing was chosen from the menu')
    return JSON.parse(await fs.promises.readFile(menuFile + '.json', 'utf8'))
  }
  const action = (rel, directory, what) => page.evaluate(([rel, directory, what]) => window.awb.treeAction('p', rel, directory, what), [rel, directory, what])
  const readLog = async () => (fs.existsSync(openLog) ? await fs.promises.readFile(openLog, 'utf8') : '').split(/\r?\n/).map(slashes).filter(Boolean)
  const clearLog = () => fs.promises.rm(openLog, { force: true })
  return { app, page, errors, data, project, clipboard, menuFile: app.menuFile, menu, action, readLog, clearLog }
}

// The menu, and what copies or opens. Saving is not asked for in this run:
// its dialog would be the desktop's own.
{
  const run = await start()
  const { app, page, errors, clipboard, menu, action, readLog, clearLog } = run
  const menuFile = run.menuFile
  const real = slashes(fs.realpathSync.native(run.project))
  try {
    await check('a file\'s menu has the items the Electron build has, in its order', async () => {
      const file = await menu('note.txt', false)
      assert.deepEqual(file.map((item) => item.id ?? ''), ['open', 'reload', 'reference', '', 'rename', 'move', 'trash', 'copy-path', 'reveal', 'open-with', 'save-as'], JSON.stringify(file))
      assert.deepEqual(file.map((item) => item.label ?? ''), ['打开', '刷新文件', '引用到当前终端', '', '重命名', '移动到…', '删除', '复制路径', '在资源管理器中显示', '打开方式', '另存为…'])
      assert.deepEqual(file[7].items.map((item) => [item.id, item.label]), [['copy-full', '复制完整路径'], ['copy-relative', '复制项目相对路径']])
      assert.deepEqual([file[9].items[0].id, file[9].items[0].label], ['open-default', '默认应用'])
      // Every editor offered after the default application is one that is installed.
      for (const item of file[9].items.slice(1)) assert.match(item.id, /^editor:(vscode|cursor|windsurf|sublime|notepad-plus)$/, item.id)
    })

    await check('a folder\'s menu offers what a folder can take, and the root less', async () => {
      const folder = await menu('src', true)
      assert.deepEqual(folder.map((item) => item.id ?? ''), ['create-file', 'create-directory', 'import-files', 'import-directory', '', 'rename', 'move', 'trash', 'copy-path', 'reveal'])
      assert.deepEqual([folder[2].label, folder[9].label], ['导入文件…', '在资源管理器中打开'])
      assert.deepEqual((await menu('', true)).map((item) => item.id ?? ''), ['create-file', 'create-directory', 'import-files', 'import-directory', '', 'copy-path', 'reveal'])
    })

    await check('an entry whose kind changed is said to have changed', async () => {
      await assert.rejects(menu('note.txt', true), (error) => String(error).includes('文件类型已更改，请刷新目录'))
      await assert.rejects(action('src', false, 'reveal'), (error) => String(error).includes('文件类型已更改，请刷新目录'))
    })

    await check('copying a path puts it on the clipboard and tells the page nothing', async () => {
      assert.equal(await action('note.txt', false, 'copy-full'), null)
      assert.equal(slashes(await fs.promises.readFile(clipboard, 'utf8')), real + '/note.txt')
      assert.equal(await action('note.txt', false, 'copy-relative'), null)
      assert.equal(await fs.promises.readFile(clipboard, 'utf8'), 'note.txt')
      assert.equal(await action('', true, 'copy-full'), null)
      assert.equal(slashes(await fs.promises.readFile(clipboard, 'utf8')), real)
    })

    await check('a file is shown selected in its folder, and opens with its default application', async () => {
      await clearLog()
      assert.equal(await action('note.txt', false, 'reveal'), null)
      assert.deepEqual(await readLog(), [real + '/note.txt'])
      await clearLog()
      assert.equal(await action('note.txt', false, 'open-default'), null)
      assert.deepEqual(await readLog(), [real + '/note.txt'])
      // A folder is opened as a folder is.
      await clearLog()
      assert.equal(await action('src', true, 'reveal'), null)
      assert.deepEqual(await readLog(), [real + '/src'])
    })

    await check('what the menu does not offer is refused', async () => {
      await assert.rejects(action('note.txt', false, 'editor:gone'), (error) => String(error).includes('该编辑器不可用，请重新打开菜单'))
      await assert.rejects(action('note.txt', false, 'print'), (error) => String(error).includes('不支持此操作'))
    })

    await check('a right click on a file of the tree asks for its menu', async () => {
      // The file panel starts closed; its button opens it, and the tree lists
      // the project's files in the files mode.
      await page.click('[data-a=right]')
      await page.click('[data-a=rmode][data-id=files]')
      const row = page.locator('[data-a=preview][data-id="note.txt"]').first()
      await row.waitFor({ timeout: 8000 })
      await fs.promises.rm(menuFile + '.json', { force: true })
      await row.click({ button: 'right' })
      // The shell takes the menu as dismissed, as nothing was chosen from the
      // file; what it was given is the file's menu.
      let template = null
      for (let wait = 0; wait < 40 && template === null; wait++) {
        template = await fs.promises.readFile(menuFile + '.json', 'utf8').then(JSON.parse, () => null)
        if (template === null) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(Array.isArray(template), 'the shell was given a menu')
      assert.deepEqual(template.map((item) => item.id ?? ''), ['open', 'reload', 'reference', '', 'rename', 'move', 'trash', 'copy-path', 'reveal', 'open-with', 'save-as'], JSON.stringify(template))
    })

    await check('no error was thrown by the page', async () => { assert.deepEqual(errors, []) })
  } finally {
    await app.close()
  }
}

// Saving elsewhere: `AWB_SAVE_PATH` answers the desktop's dialog for it.
{
  const free = fs.mkdtempSync(path.join(os.tmpdir(), 'pello-tree-menu-save-'))
  const saved = path.join(free, 'saved-elsewhere.txt')
  {
    const run = await start({ AWB_SAVE_PATH: saved })
    try {
      await check('saving elsewhere copies the file to the name chosen', async () => {
        assert.equal(await run.action('note.txt', false, 'save-as'), null)
        assert.equal(await fs.promises.readFile(saved, 'utf8'), 'a note to be saved elsewhere\n')
      })
    } finally { await run.app.close() }
  }
  {
    await fs.promises.writeFile(saved, 'something else already here')
    const run = await start({ AWB_SAVE_PATH: saved })
    try {
      await check('saving elsewhere leaves a name that is taken as it was', async () => {
        await assert.rejects(run.action('note.txt', false, 'save-as'), (error) => String(error).includes('目标已存在，请选择新的文件名'))
        assert.equal(await fs.promises.readFile(saved, 'utf8'), 'something else already here')
        assert.deepEqual((await fs.promises.readdir(free)).filter((name) => name.startsWith('.awb-copy-')), [], 'no half-made copy is left behind')
      })
    } finally { await run.app.close() }
  }
}

if (failures.length) throw new Error(failures.length + ' check(s) failed')
