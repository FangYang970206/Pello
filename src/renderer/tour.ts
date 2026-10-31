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

    click('[data-a=rmode][data-id=files]')
    await sleep(400)
    for (const id of ['src', 'src/query', 'tests', 'docs']) {
      const folder = document.querySelector(`[data-a=tog][data-id="${id}"]`) as HTMLElement | null
      folder?.click()
      await sleep(80)
    }
    await shot('v4_19_files')
    const readme = $('[data-a=preview]')
    if (readme) {
      readme.click()
      await sleep(400)
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

    await window.awb.winResize(1024, 700)
    await sleep(300)
    await shot('v4_min_width')
    await window.awb.winResize(1440, 900)
  } catch (err) {
    console.error('tour failed', err)
    errors.push(err instanceof Error ? err.stack || err.message : String(err))
    try {
      await shot('v4_tour_error')
    } catch {
      /* ignore */
    }
  }
  console.log('TOUR_DONE', JSON.stringify(errors))
  await sleep(200)
  await window.awb.winClose()
}

function fillInput(node: HTMLInputElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  proto?.set?.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
  node.dispatchEvent(new Event('change', { bubbles: true }))
}
