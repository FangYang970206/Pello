const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function $(selector: string): HTMLElement | null {
  return document.querySelector(selector)
}

async function waitFor(selector: string, timeout = 8000): Promise<HTMLElement> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const node = $(selector)
    if (node) return node
    await sleep(80)
  }
  throw new Error(`找不到 ${selector}`)
}

async function shot(name: string): Promise<void> {
  await sleep(280)
  console.log('shot', name)
  await window.awb.shot(name)
}

function click(selector: string): void {
  const node = $(selector)
  if (!node) throw new Error(`找不到 ${selector}`)
  node.click()
}

function fill(selector: string, value: string): void {
  const node = $(selector) as HTMLInputElement | null
  if (!node) throw new Error(`找不到 ${selector}`)
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  proto?.set?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
}

async function until(check: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await sleep(80)
  }
  throw new Error('等待超时')
}

let step = 'start'

export async function runTour(): Promise<void> {
  const errors: string[] = []
  try {
    await sleep(400)
    await waitFor('[data-a=newproj]')
    await shot('v4_01_empty')

    click('[data-a=newproj]')
    await waitFor('[data-np=name]')
    await shot('v4_02_newproj_blank')
    fill('[data-np=name]', 'virtualgraph')
    fill('[data-np=path]', '/tmp/awb-demo')
    await until(() => !!document.querySelector('#pchk small.ok, #pchk small.bad, #pchk small'))
    await sleep(200)
    await shot('v4_03_newproj_local')
    click('[data-a=np-addhost]')
    await waitFor('[data-nh=name]')
    await shot('v4_06_newproj_addhost')
    fill('[data-nh=name]', 'build-01')
    fill('[data-nh=addr]', 'yang@127.0.0.1')
    click('[data-a=np-savehost]')
    await sleep(1200)
    await shot('v4_07_newproj_remote')
    const create = await waitFor('[data-a=np-ok]')
    if ((create as HTMLButtonElement).disabled) throw new Error('创建按钮不可用')
    create.click()
    await waitFor('[data-a=quick]')
    await sleep(600)
    await shot('v4_04_project_noterm')

    click('[data-a=quick]')
    await waitFor('.tab')
    await sleep(900)
    await shot('v4_05_first_term')

    await addProject('query-service', '/tmp/awb-svc')
    await addProject('framework', '/tmp/awb-fw')
    clickText('[data-a=proj]', 'virtualgraph')
    await waitFor('.tab')
    await sleep(200)

    click('.addtab[data-a=newterm]')
    await waitFor('[data-a=ntk][data-id=opencode]')
    click('[data-a=ntk][data-id=opencode]')
    await shot('v4_11_newterm_opencode')
    click('[data-a=nt-ok]')
    await sleep(700)

    for (const id of ['aider', 'cursor', 'opencode']) {
      click('.addtab[data-a=newterm]')
      await waitFor(`[data-a=ntk][data-id=${id}]`)
      click(`[data-a=ntk][data-id=${id}]`)
      click('[data-a=nt-ok]')
      await sleep(500)
      await shot(`v4_12_term_${id}`)
    }

    click('.addtab[data-a=newterm]')
    await waitFor('[data-a=ntk][data-id=shell]')
    click('[data-a=ntk][data-id=shell]')
    await shot('v4_08_newterm_remote')
    click('[data-a=nt-ok]')
    await waitFor('.pstate.idle, .pstate.running')
    await shot('v4_12_term_shell')
    await sleep(400)
    const shellId = (await waitFor('.tab.on [data-a=tab]')).dataset.id || ''
    window.awb.ptyWrite(shellId, "python3 -c 'import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); print(\"running\", flush=True); time.sleep(180)'\r")
    await waitFor('.pstate.running', 6000)
    await sleep(300)
    await shot('v4_10_workspace')
    await shot('v4_09_remote_term')

    click('[data-a=ctrlc]')
    await sleep(400)
    await shot('v4_13_ctrlc_once')
    click('[data-a=ctrlc]')
    await waitFor('.pstate.exited, .pstate.failed, .pstate.idle', 6000)
    await sleep(400)
    await shot('v4_14_ctrlc_exit')

    window.awb.ptyWrite(shellId, "python3 -c 'import signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); time.sleep(180)'\r")
    await waitFor('.pstate.running', 6000)
    click('[data-a=kill]')
    await waitFor('[data-a=confirm]')
    await shot('v4_15_kill_confirm')
    click('[data-a=confirm]')
    await waitFor('.pstate.failed, .pstate.exited', 6000)
    await sleep(300)
    await shot('v4_16_killed')

    window.awb.ptyWrite(shellId, 'exit 2\r')
    await waitFor('.pstate.failed', 6000)
    await sleep(300)
    await shot('v4_17_exit2_failed')

    click('[data-a=restart]')
    await sleep(500)
    click('[data-a=split]')
    await sleep(700)
    await shot('v4_18_split')
    const orderedPanes = () =>
      [...document.querySelectorAll('.pane[data-a=pane]')]
        .filter((node) => !node.hasAttribute('hidden'))
        .sort((a, b) => Number((a as HTMLElement).style.order) - Number((b as HTMLElement).style.order))
    const focusOnRight = () => orderedPanes()[1]?.classList.contains('focus') === true
    const area = document.querySelector('.pane.focus .xterm-helper-textarea') as HTMLTextAreaElement | null
    area?.focus()
    area?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }))
    await sleep(200)
    if (!focusOnRight()) {
      ;(orderedPanes()[1] as HTMLElement | undefined)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    }
    await until(focusOnRight, 4000)
    await sleep(150)
    await shot('v4_18_split_right')
    const back = document.querySelector('.pane.focus .xterm-helper-textarea') as HTMLTextAreaElement | null
    back?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }))
    await sleep(200)

    click('[data-a=rmode][data-id=files]')
    await sleep(400)
    for (const id of ['src', 'src/query', 'tests', 'docs']) {
      const folder = document.querySelector(`[data-a=tog][data-id="${id}"]`) as HTMLElement | null
      folder?.click()
      await sleep(80)
    }
    await shot('v4_19_files')
    const readme = $('[data-a=preview][data-id="src/query/Executor.java"]') || $('[data-a=preview]')
    if (readme) {
      readme.click()
      await until(() => !!document.querySelector('.tab.preview'))
      await sleep(200)
      await shot('v4_19_preview')
    }

    click('[data-a=rmode][data-id=changes]')
    await waitFor('[data-a=diff]')
    const diffBtn = $('[data-a=diff][data-id="src/query/TopNOperator.java"]') || $('[data-a=diff]')
    if (!diffBtn) throw new Error('没有变更文件')
    diffBtn.click()
    await waitFor('.diff')
    await sleep(300)
    await shot('v4_20_diff_unified')
    click('[data-a=dmode][data-id=split]')
    await sleep(200)
    await shot('v4_21_diff_split')
    click('[data-a=right]')
    await sleep(200)
    await shot('v4_22_right_collapsed')
    click('[data-a=right]')
    await sleep(200)
    click('[data-a=discard]')
    await waitFor('[data-a=confirm]')
    await shot('v4_23_discard_confirm')
    click('[data-a=mclose]')
    await sleep(200)

    window.awb.ptyWrite(shellId, 'echo hello > notes-new.txt\r')
    await until(() => !!document.querySelector('[data-a=diff][data-id="notes-new.txt"]'), 12000)
    click('[data-a=diff][data-id="notes-new.txt"]')
    await until(() => {
      const path = document.querySelector('.diffbar .path')?.textContent || ''
      const label = document.querySelector('[data-a=discard]')?.textContent || ''
      return path.includes('notes-new.txt') && label.includes('删除文件')
    }, 12000)
    await sleep(120)
    click('[data-a=discard]')
    await waitFor('[data-a=confirm]')
    await shot('v4_23_delete_untracked')
    click('[data-a=mclose]')
    await sleep(200)

    const limits = $('[data-a=diff][data-id="docs/limits.md"]')
    if (limits) {
      limits.click()
      await sleep(300)
      click('[data-a=discard]')
      await waitFor('[data-a=confirm]')
      click('[data-a=confirm]')
      await sleep(500)
    }

    await sleep(2800)
    click('[data-a=settings]')
    await waitFor('[data-a=sec][data-id=general]')
    await shot('v4_30_set_general')
    click('[data-a=sec][data-id=look]')
    await shot('v4_30_set_look')
    click('[data-a=sec][data-id=agents]')
    await shot('v4_30_set_agents')
    click('[data-a=sec][data-id=hosts]')
    await shot('v4_30_set_hosts')
    click('[data-a=sec][data-id=plugins]')
    await shot('v4_30_set_plugins')
    click('[data-a=sec][data-id=keys]')
    await shot('v4_30_set_keys')

    click('[data-a=sec][data-id=agents]')
    await waitFor('button[data-a=custom]')
    click('button[data-a=custom]')
    await waitFor('[data-ce=name]')
    await shot('v4_31_exec_new')
    fill('[data-ce=name]', '内部 Agent')
    fill('[data-ce=cmd]', 'corp-agent')
    fill('[data-ce=args]', '--interactive')
    click('[data-a=ce-test]')
    await sleep(800)
    await shot('v4_32_exec_test')
    click('[data-a=ce-save]')
    await sleep(400)
    await shot('v4_33_exec_saved')
    click('[data-a=back]')
    await waitFor('.addtab[data-a=newterm]')
    click('.addtab[data-a=newterm]')
    await waitFor('[data-a=nt-ok]')
    const corp = [...document.querySelectorAll('[data-a=ntk]')].find((node) => node.textContent?.includes('内部')) as HTMLElement | undefined
    corp?.click()
    click('[data-a=nt-ok]')
    await sleep(600)
    await shot('v4_12_term_corp')
    await shot('v4_exit_banner')
    click('[data-a=settings]')
    await waitFor('[data-a=sec][data-id=agents]')

    click('[data-a=sec][data-id=hosts]')
    await until(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('添加机器')))
    const addHost = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('添加机器'))
    addHost?.click()
    await waitFor('.dlg input[placeholder="build-02"]')
    fill('.dlg input[placeholder="build-02"]', 'gpu-02')
    const inputs = document.querySelectorAll('.dlg input.mono')
    ;(inputs[0] as HTMLInputElement).focus()
    fillInput(inputs[0] as HTMLInputElement, 'yang')
    fillInput(inputs[1] as HTMLInputElement, '127.0.0.1')
    await shot('v4_34_host_dialog')
    click('[data-a=hsave]')
    await sleep(300)

    click('[data-a=sec][data-id=look]')
    await waitFor('[data-a=theme][data-id=light]')
    click('[data-a=theme][data-id=light]')
    await sleep(200)
    await shot('v4_35_light_look')
    click('[data-a=sec][data-id=agents]')
    await shot('v4_36_light_agents')
    click('[data-a=back]')
    await waitFor('.center')
    await sleep(300)
    await shot('v4_37_light_workspace')
    const again = $('[data-a=diff]')
    if (again) {
      again.click()
      await waitFor('.diff')
      click('[data-a=dmode][data-id=unified]')
      await sleep(200)
      await shot('v4_38_light_diff')
    }
    click('.addtab[data-a=newterm]')
    await waitFor('[data-a=nt-ok]')
    await shot('v4_39_light_newterm')
    click('[data-a=mclose]')
    click('.side [data-a=newproj]')
    await waitFor('[data-np=name]')
    await shot('v4_40_light_newproj')
    ;($('[data-np=name]') as HTMLInputElement).focus()
    await shot('v4_41_light_focus')
    click('[data-a=mclose]')

    step = 'min-width'
    await window.awb.winResize(1024, 700)
    await sleep(300)
    await shot('v4_min_width')
    await window.awb.winResize(1440, 900)
    await sleep(200)
    step = 'back-to-dark'
    click('[data-a=settings]')
    await waitFor('[data-a=sec][data-id=look]')
    click('[data-a=sec][data-id=look]')
    await waitFor('[data-a=theme][data-id=dark]')
    click('[data-a=theme][data-id=dark]')
    await sleep(200)
    click('[data-a=back]')
    await waitFor('.center')
    await sleep(200)

    step = 'focus-project'
    clickText('[data-a=proj]', 'virtualgraph')
    await sleep(200)
    const corpTab = [...document.querySelectorAll('.tab')].find((node) => node.textContent?.includes('内部'))
    const corpBtn = corpTab?.querySelector('[data-a=tab]') as HTMLElement | undefined
    if (!corpBtn) throw new Error('没有内部 Agent 标签')
    corpBtn.click()
    await sleep(200)
    if (document.querySelector('[data-a=split][aria-pressed="true"]')) {
      click('[data-a=split]')
      await sleep(200)
      corpBtn.click()
      await sleep(150)
    }
    await waitFor('.pstate.failed', 4000)
    await sleep(250)
    step = 'close-settled'
    await closeExcept((tab) => !!tab.textContent?.includes('内部'))
    step = 'states'
    const exitedId = await openShell()
    window.awb.ptyWrite(exitedId, 'exit 0\r')
    await until(() => document.querySelector(`.tab [data-a=tab][data-id="${exitedId}"]`)?.getAttribute('data-state') === 'exited', 8000)
    await openShell()
    const runId = await openShell()
    window.awb.ptyWrite(runId, "python3 -c 'import time; print(\"running\", flush=True); time.sleep(180)'\r")
    await waitFor('.pstate.running', 8000)
    await sleep(400)
    await shot('v4_10_states')
    for (let i = 0; i < 6; i++) {
      click('.addtab[data-a=newterm]')
      await waitFor('[data-a=nt-ok]')
      click('[data-a=ntk][data-id=shell]')
      await sleep(60)
      click('[data-a=nt-ok]')
      await sleep(250)
    }
    const first = document.querySelector('.tab [data-a=tab]') as HTMLElement | null
    first?.click()
    await sleep(250)
    await shot('v4_10_overflow')
    const menu = $('[data-a=tabs-menu]')
    if (menu) {
      menu.click()
      await sleep(200)
      await shot('v4_10_tabmenu')
      menu.click()
    }
    const runningTab = [...document.querySelectorAll('.tab')].find((node) => node.querySelector('[data-state="running"]'))
    const runningButton = runningTab?.querySelector('[data-a=tab]') as HTMLElement | undefined
    runningButton?.click()
    await waitFor('.pstate.running', 4000)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))
    await waitFor('[data-a=confirm]')
    await shot('v4_ctrlw_confirm')
    click('[data-a=mclose]')
    await sleep(150)

    const hovered = [...document.querySelectorAll('[data-a=proj]')].find((node) => node.querySelector('.live')) || document.querySelector('[data-a=proj]')
    const hoverStyle = document.createElement('style')
    hoverStyle.textContent = `[data-a=proj][data-id="${hovered?.getAttribute('data-id') || ''}"] .more{display:grid}[data-a=proj][data-id="${hovered?.getAttribute('data-id') || ''}"] .live{visibility:hidden}`
    document.head.appendChild(hoverStyle)
    await shot('v4_proj_hover')
    hoverStyle.remove()
    const runningProj = [...document.querySelectorAll('[data-a=proj]')].find((node) => node.querySelector('.live')) || document.querySelector('[data-a=proj]')
    const runningMore = runningProj?.querySelector('[data-a=proj-more]') as HTMLElement | undefined
    runningMore?.click()
    await waitFor('[data-a=proj-remove]')
    click('[data-a=proj-remove]')
    await waitFor('[data-a=confirm]')
    await shot('v4_proj_remove')
    click('[data-a=mclose]')
  } catch (err) {
    console.error('tour failed', step, err)
    const message = err instanceof Error ? err.stack || err.message : String(err)
    errors.push(`${step}: ${message}`)
    try {
      const banner = document.createElement('pre')
      banner.textContent = `${step}\n${message}`
      banner.style.cssText = 'position:fixed;z-index:100;left:16px;top:48px;max-width:980px;background:#3a1010;color:#fff;padding:12px 14px;font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap'
      document.body.appendChild(banner)
      await shot('v4_tour_error')
    } catch {
      /* ignore */
    }
  }
  console.log('TOUR_DONE', JSON.stringify(errors))
  await sleep(200)
  await window.awb.winClose()
}

function clickText(selector: string, text: string): void {
  const node = [...document.querySelectorAll(selector)].find((item) => item.textContent?.includes(text)) as HTMLElement | undefined
  if (!node) throw new Error(`找不到 ${text}`)
  node.click()
}

async function addProject(name: string, dir: string): Promise<void> {
  click('.side [data-a=newproj]')
  await waitFor('[data-np=name]')
  fill('[data-np=name]', name)
  fill('[data-np=path]', dir)
  await until(() => !!document.querySelector('#pchk small.ok, #pchk small'))
  await sleep(200)
  const create = await waitFor('[data-a=np-ok]')
  if ((create as HTMLButtonElement).disabled) throw new Error(`无法创建 ${name}`)
  create.click()
  await until(() => !!document.querySelector(`[data-a=proj]`) && document.body.textContent?.includes(name))
  await sleep(250)
}

async function closeExcept(keep: (tab: Element) => boolean): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const button = [...document.querySelectorAll('.tab [data-a=close]')].find((node) => {
      const tab = node.closest('.tab')
      if (!tab || keep(tab)) return false
      const state = tab.querySelector('[data-state]')?.getAttribute('data-state')
      return state !== 'running'
    }) as HTMLElement | undefined
    if (!button) return
    button.click()
    await sleep(80)
  }
}

async function openShell(): Promise<string> {
  click('.addtab[data-a=newterm]')
  await waitFor('[data-a=ntk][data-id=shell]')
  click('[data-a=ntk][data-id=shell]')
  await sleep(60)
  click('[data-a=nt-ok]')
  await waitFor('.tab.on [data-a=tab]')
  await waitFor('.pstate.idle, .pstate.running', 8000)
  await sleep(150)
  return (document.querySelector('.tab.on [data-a=tab]') as HTMLElement | null)?.dataset.id || ''
}

function fillInput(node: HTMLInputElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  proto?.set?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
}
