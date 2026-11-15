import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const helper = `
  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName
    if (tag === 'BUTTON') return 'button'
    if (tag === 'A' && el.hasAttribute('href')) return 'link'
    if (tag === 'SELECT') return 'combobox'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (['button', 'submit', 'reset'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    if (/^H[1-6]$/.test(tag)) return 'heading'
    if (tag === 'DIALOG') return 'dialog'
    if (tag === 'SECTION' && el.getAttribute('aria-label')) return 'region'
    return ''
  }
  function labelledText(el) {
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled) return labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim()
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim()
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
      if (label) return label.innerText.trim()
    }
    const wrap = el.closest('label')
    if (wrap && wrap !== el) {
      const copy = wrap.cloneNode(true)
      copy.querySelectorAll('input,select,textarea,button').forEach((node) => node.remove())
      return copy.textContent.trim()
    }
    return (el.innerText || el.textContent || '').trim()
  }
  function namePattern(name) {
    if (name && typeof name === 'object' && name.__re) return new RegExp(name.__re, name.__flags || '')
    return null
  }
  function named(el, name, exact) {
    if (name == null) return true
    const value = labelledText(el)
    const pattern = namePattern(name)
    if (pattern) return pattern.test(value)
    return exact ? value === name : String(value).includes(String(name))
  }
  function byLabel(name, exact) {
    const pattern = namePattern(name)
    const matches = (text) => pattern ? pattern.test(text) : exact ? text === name : String(text).includes(String(name))
    const controls = []
    for (const label of document.querySelectorAll('label')) {
      const copy = label.cloneNode(true)
      copy.querySelectorAll('input,select,textarea,button').forEach((node) => node.remove())
      const text = copy.textContent.trim()
      if (!matches(text)) continue
      const control = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input,select,textarea,button')
      if (control) controls.push(control)
    }
    for (const el of document.querySelectorAll('[aria-label]')) {
      if (matches(el.getAttribute('aria-label') || '')) controls.push(el)
    }
    return [...new Set(controls)]
  }
  function byText(text, exact) {
    const pattern = namePattern(text)
    const all = [...document.querySelectorAll('body *')].filter((el) => {
      const value = (el.innerText || '').trim()
      if (pattern) return pattern.test(value)
      return exact ? value === text : value.includes(text)
    })
    return all.filter((el) => ![...el.children].some((child) => all.includes(child)))
  }
  function resolve(steps) {
    let nodes = [document]
    for (const step of steps) {
      if (Object.prototype.hasOwnProperty.call(step, 'nth')) {
        const index = step.nth < 0 ? nodes.length + step.nth : step.nth
        nodes = nodes[index] ? [nodes[index]] : []
        continue
      }
      const next = []
      for (const base of nodes) {
        if (step.parent) {
          if (base.parentElement) next.push(base.parentElement)
          continue
        }
        let found = []
        if (step.selector) found = [...base.querySelectorAll(step.selector)]
        else if (step.label != null) found = byLabel(step.label, step.exact)
        else if (step.role) found = [...base.querySelectorAll('*')].filter((el) => roleOf(el) === step.role && named(el, step.name, step.exact))
        else if (step.text != null) found = byText(step.text, step.exact)
        else found = [base]
        if (step.hasText != null) {
          const pattern = namePattern(step.hasText)
          found = found.filter((el) => pattern ? pattern.test(el.innerText || '') : (el.innerText || '').includes(step.hasText))
        }
        if (step.hasSelector) found = found.filter((el) => el.querySelector(step.hasSelector))
        next.push(...found)
      }
      nodes = [...new Set(next)].filter((node) => node && node.nodeType === 1)
    }
    return nodes
  }
  function visible(el) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return el.getClientRects().length > 0
  }
  function only(steps) {
    const nodes = resolve(steps)
    if (nodes.length !== 1) throw new Error('strict mode violation: ' + nodes.length + ' matches for ' + JSON.stringify(steps))
    return nodes[0]
  }
  async function setValue(el, value) {
    if (el.isContentEditable) {
      el.focus()
      const selectContents = () => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      selectContents()
      document.execCommand('insertText', false, value)
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await frame()
      // WebKit insertText leaves an empty first line when it replaces a block
      // selection. Chromium does not, so delete that line before the draft is saved.
      if (!value.startsWith('\\n')) {
        const first = el.querySelector(':scope > .cm-line')
        const next = first && first.nextElementSibling
        if (first && !first.textContent && first.querySelector('br') && next && next.classList.contains('cm-line')) {
          const range = document.createRange()
          range.setStart(first, 0)
          range.setEnd(next, 0)
          const selection = window.getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          document.execCommand('delete', false, null)
          await frame()
        }
      }
      return
    }
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value)
    if (el._valueTracker) el._valueTracker.setValue('__awb_previous__')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function keyInit(combo) {
    const parts = combo.split('+')
    const key = parts.pop()
    return {
      key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
      ctrlKey: parts.includes('Control'), shiftKey: parts.includes('Shift'),
      altKey: parts.includes('Alt'), metaKey: parts.includes('Meta'),
      bubbles: true, cancelable: true, composed: true,
    }
  }
  function pressKey(target, combo) {
    const init = keyInit(combo)
    const down = new KeyboardEvent('keydown', init)
    target.dispatchEvent(down)
    const space = init.key === ' ' || init.key === 'Space'
    if (!down.defaultPrevented && init.key === 'Enter' && target.form && target.tagName !== 'BUTTON') target.form.requestSubmit()
    if (!down.defaultPrevented && (init.key === 'Enter' || space) && (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button')) target.click()
    if (!down.defaultPrevented && space && target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio')) target.click()
    if (!down.defaultPrevented && init.key === 'Tab') {
      const items = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length)
      const next = items[items.indexOf(target) + (init.shiftKey ? -1 : 1)]
      if (next) next.focus()
    }
    if (!down.defaultPrevented && init.key === 'Escape') {
      const dialog = target.closest('dialog')
      if (dialog) dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }))
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init))
  }
`

function packValue(value) {
  return JSON.stringify(value, (_key, item) => item instanceof RegExp ? { __re: item.source, __flags: item.flags } : item)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve(body))
    })
    request.setTimeout(1000, () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

export async function connectWebKitPage(port) {
  const deadline = Date.now() + 20000
  let last = ''
  let socket = ''
  while (Date.now() < deadline && !socket) {
    try {
      const body = await httpText(`http://127.0.0.1:${port}/`)
      last = body.slice(0, 180)
      socket = body.match(/\/socket\/\d+\/\d+\/WebPage/)?.[0] || ''
    } catch (error) {
      last = String(error)
    }
    if (!socket) await sleep(100)
  }
  if (!socket) throw new Error(`WebKit inspector did not list a page socket: ${last}`)
  const page = await WebKitPage.connect(`ws://127.0.0.1:${port}${socket}`)
  await page.waitUntilReady()
  return page
}

class WebKitPage {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.timeout = 15000
    this.targets = new Map()
    this.pendingOuter = new Map()
    this.pendingInner = new Map()
    this.pageErrors = []
    this.mainId = ''
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)))
    ws.addEventListener('close', () => this.close())
  }

  static connect(url) {
    const ws = new WebSocket(url)
    const page = new WebKitPage(ws)
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(page))
      ws.addEventListener('error', () => reject(new Error(`WebKit inspector socket failed: ${url}`)))
    })
  }

  onMessage(data) {
    if (data.id && this.pendingOuter.has(data.id)) this.pendingOuter.get(data.id)(data)
    if (data.method === 'Target.targetCreated') this.noteTarget(data.params?.targetInfo)
    if (data.method === 'Target.targetDestroyed') this.targets.delete(data.params.targetId)
    if (data.method === 'Target.dispatchMessageFromTarget') {
      const inner = JSON.parse(data.params.message)
      if (inner.method === 'Target.targetCreated') this.noteTarget(inner.params?.targetInfo)
      if (inner.method === 'Target.targetDestroyed') this.targets.delete(inner.params?.targetId)
      const pending = this.pendingInner.get(`${data.params.targetId}:${inner.id}`)
      if (pending) pending(inner)
    }
  }

  noteTarget(info) {
    if (!info?.targetId) return
    this.targets.set(info.targetId, info)
  }

  send(method, params = {}) {
    if (this.closed) return Promise.resolve({ result: {} })
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
      this.pendingOuter.set(id, (message) => {
        clearTimeout(timer)
        this.pendingOuter.delete(id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message)
      })
    })
  }

  sendInner(targetId, method, params, timeoutMs = 10000) {
    const id = ++this.id
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} on ${targetId} timed out`)), timeoutMs)
      this.pendingInner.set(`${targetId}:${id}`, (message) => {
        clearTimeout(timer)
        this.pendingInner.delete(`${targetId}:${id}`)
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolve(message)
      })
    })
    return this.send('Target.sendMessageToTarget', { targetId, message: JSON.stringify({ id, method, params }) }).then(() => result)
  }

  async invoke(targetId, body, arg, hasArg, timeoutMs) {
    if (targetId === 'frame-bootstrap') return this.invokeBootstrap(body, arg, hasArg, timeoutMs)
    if (this.closed) return null
    const limit = timeoutMs || this.timeout
    const token = `awbEval${++this.id}`
    const expression = `window.${token} = { done: false };
      (async () => {
        const arg = ${JSON.stringify(hasArg ? arg : null)};
        const hasArg = ${hasArg ? 'true' : 'false'};
        ${helper}
        try {
          const value = await (async () => { ${body} })();
          let packed = null;
          if (value instanceof Node) packed = true;
          else if (value === undefined) packed = { __awbUndefined: true };
          else { try { packed = JSON.parse(JSON.stringify(value)); } catch { packed = null } }
          window.${token} = { done: true, ok: true, value: packed };
        } catch (error) {
          window.${token} = { done: true, ok: false, error: String(error && (error.message || error)) };
        }
      })()`
    await this.sendInner(targetId, 'Runtime.evaluate', { expression }, limit)
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
      if (this.closed) return null
      const message = await this.sendInner(targetId, 'Runtime.evaluate', { expression: `window.${token}`, returnByValue: true }, limit)
      const value = message.result?.result?.value
      if (value?.done) {
        if (!value.ok) throw new Error(value.error)
        if (value.value && value.value.__awbUndefined) return undefined
        return value.value
      }
      await sleep(20)
    }
    throw new Error(`Page script timed out: ${body.slice(0, 160)}`)
  }

  async waitUntilReady() {
    const deadline = Date.now() + 20000
    let last = ''
    while (Date.now() < deadline) {
      this.mainId = [...this.targets.values()].find((target) => target.type === 'page')?.targetId || ''
      if (this.mainId) {
        try {
          const value = await this.invoke(this.mainId, `return { url: location.href, awb: typeof window.awb, text: (document.body && document.body.innerText || '').slice(0, 160) }`)
          last = JSON.stringify(value)
          if (value?.awb === 'object' && !String(value.text).includes('Could not connect')) {
            await this.invoke(this.mainId, `if (!window.__pageErrors) { window.__pageErrors = []; window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message))); window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason && event.reason.message || event.reason))) }
              if (!window.__awbWheelListen) { window.__awbWheelListen = true; window.addEventListener('message', (event) => { if (event.data && event.data.type === 'awb-wheel-target') window.__awbHoverFrame = !!event.data.frame }) }
              return true`)
            // WebKitGTK does not answer Runtime on sandboxed iframe targets. A bootstrap
            // script is injected into later documents, including the HTML preview frame.
            this.errorTimer = setInterval(() => { void this.pullErrors() }, 100)
            return
          }
        } catch (error) {
          last = String(error)
        }
      }
      await sleep(80)
    }
    throw new Error(`Tauri webview did not load the workbench: ${last}`)
  }

  async pullErrors() {
    if (!this.mainId) return
    try {
      const messages = await this.invoke(this.mainId, `const list = window.__pageErrors || []; window.__pageErrors = []; return list`)
      for (const message of messages || []) for (const listener of this.pageErrors) listener({ message })
    } catch { /* The page can be navigating. */ }
  }

  async invokeBootstrap(body, arg, hasArg, timeoutMs) {
    const limit = timeoutMs || this.timeout
    const id = ++this.id
    const source = `(async () => {
      const arg = ${JSON.stringify(hasArg ? arg : null)};
      const hasArg = ${hasArg ? 'true' : 'false'};
      ${helper}
      try {
        const value = await (async () => { ${body} })();
        let packed = null;
        try { packed = JSON.parse(JSON.stringify(value)); } catch { packed = null }
        parent.postMessage({ type: 'awb-eval-result', id: ${id}, ok: true, value: packed }, '*')
      } catch (error) {
        parent.postMessage({ type: 'awb-eval-result', id: ${id}, ok: false, error: String(error && (error.message || error)) }, '*')
      }
    })()`
    await this.invoke(this.mainId, `if (!window.__awbFrameWait) {
      window.__awbFrameWait = new Map()
      window.addEventListener('message', (event) => {
        const data = event.data
        if (!data) return
        if (data.type === 'awb-eval-ready') window.__awbFrameReady = data.id
        if (data.type !== 'awb-eval-result') return
        const slot = window.__awbFrameWait.get(data.id)
        if (slot) slot.result = data
      })
    }
    window.__awbFrameWait.set(${id}, { result: null, sent: false })
    return true`, null, false, limit)
    const payload = JSON.stringify(source)
    const deadline = Date.now() + limit
    while (Date.now() < deadline) {
      if (this.closed) return null
      await this.invoke(this.mainId, `const slot = window.__awbFrameWait.get(${id}); const frame = document.querySelector('iframe'); if (!slot || !frame || !frame.contentWindow) return; if (!slot.sent && window.__awbFrameReady === ${id}) { frame.contentWindow.postMessage({ type: 'awb-eval', id: ${id}, source: ${payload} }, '*'); slot.sent = true } else if (!slot.sent) frame.contentWindow.postMessage({ type: 'awb-eval-ping', id: ${id} }, '*')`, null, false, 2000)
      const value = await this.invoke(this.mainId, `return (window.__awbFrameWait.get(${id}) || {}).result || null`, null, false, 2000)
      if (value) {
        if (!value.ok) throw new Error(value.error || 'iframe evaluation failed')
        return value.value
      }
      await sleep(20)
    }
    const frame = await this.invoke(this.mainId, `const node = document.querySelector('iframe'); return { src: node?.src || '', ready: !!window.__awbFrameReady, error: document.querySelector('.file-error,.toast')?.textContent || '' }`, null, false, 2000).catch((error) => ({ src: '', ready: false, error: String(error) }))
    throw new Error(`iframe evaluation timed out src=${frame?.src || ''} ready=${frame?.ready} error=${frame?.error || ''}`)
  }

  async frameTarget() {
    const deadline = Date.now() + this.timeout
    let last = ''
    while (Date.now() < deadline) {
      const frame = await this.invoke(this.mainId, `const node = document.querySelector('iframe');
        return { src: node?.src || '', count: document.querySelectorAll('iframe').length, error: document.querySelector('.file-error')?.textContent || '', tab: document.querySelector('.tab.on')?.textContent || '', mode: document.querySelector('.html-preview, .ProseMirror, textarea')?.className || '' }`, null, false, 2000)
      const src = frame?.src || ''
      if (src) return 'frame-bootstrap'
      last = `src=${src} count=${frame?.count ?? ''} tab=${frame?.tab || ''} mode=${frame?.mode || ''} error=${frame?.error || ''}`
      await sleep(50)
    }
    throw new Error(`iframe inspector target not found: ${last}`)
  }

  async targetFor(steps) {
    const frame = steps.find((step) => step.frame)
    if (!frame) return { targetId: this.mainId, steps }
    return { targetId: await this.frameTarget(), steps: steps.slice(steps.indexOf(frame) + 1) }
  }

  setDefaultTimeout(timeout) { this.timeout = timeout }

  async reload() {
    await this.invoke(this.mainId, `setTimeout(() => location.reload(), 30); return true`)
    await sleep(200)
    const deadline = Date.now() + 20000
    let last = ''
    while (Date.now() < deadline) {
      this.mainId = [...this.targets.values()].find((target) => target.type === 'page')?.targetId || this.mainId
      try {
        const value = await this.invoke(this.mainId, `return { awb: typeof window.awb, text: (document.body && document.body.innerText || '').slice(0, 80) }`)
        last = JSON.stringify(value)
        if (value?.awb === 'object' && !String(value.text).includes('Could not connect')) return
      } catch (error) { last = error instanceof Error ? error.message : String(error) }
      await sleep(100)
    }
    throw new Error(`Tauri webview did not reload the workbench: ${last}`)
  }

  mainFrame() { return this._mainFrame || (this._mainFrame = { url: () => 'main' }) }

  on(event, listener) {
    if (event === 'pageerror') { this.pageErrors.push(listener); return }
    if (event === 'framenavigated') { this.watchFrames(listener); return }
    throw new Error(`Unsupported page event ${event}`)
  }

  watchFrames(listener) {
    let seen = ''
    const timer = setInterval(() => {
      if (this.closed) { clearInterval(timer); return }
      void this.evaluate(() => document.querySelector('iframe')?.src || '').then((src) => {
        if (!seen) { seen = src || 'none'; return }
        if (src && src !== seen) { seen = src; listener({ url: () => src }) }
      }).catch(() => clearInterval(timer))
    }, 80)
    this.frameTimers = this.frameTimers || []
    this.frameTimers.push(timer)
  }

  context() {
    return { newCDPSession: async () => { throw new Error('This WebKit inspector has no Chrome input domain') } }
  }

  emulateMedia(options = {}) {
    if (options.reducedMotion !== 'reduce') return Promise.resolve()
    return this.evaluate(() => {
      const style = document.createElement('style')
      style.setAttribute('data-awb-reduced-motion', '')
      style.textContent = '*{animation:none!important;transition:none!important}'
      document.documentElement.appendChild(style)
    })
  }

  async evaluate(fn, arg) {
    const hasArg = arguments.length > 1
    return this.invoke(this.mainId, `const fn = ${fn.toString()}; return ${hasArg ? 'fn(arg)' : 'fn()'};`, arg, hasArg)
  }

  async waitForFunction(fn, arg) {
    const deadline = Date.now() + this.timeout
    let last
    while (Date.now() < deadline) {
      last = await this.evaluate(fn, arg)
      if (last) return last
      await sleep(30)
    }
    throw new Error(`waitForFunction timed out: ${JSON.stringify(last)}`)
  }

  waitForTimeout(ms) { return sleep(ms) }

  async setViewportSize({ width, height }) {
    await this.evaluate((size) => window.awb.winResize(size.width, size.height), { width, height })
    await this.waitForFunction((size) => Math.abs(innerWidth - size.width) <= 4 && Math.abs(innerHeight - size.height) <= 80, { width, height })
  }

  keyboard = {
    down: async (key) => { if (key === 'Control' || key === 'Meta') this.ctrl = true },
    up: async (key) => { if (key === 'Control' || key === 'Meta') this.ctrl = false },
    press: (combo) => this.invoke(this.mainId, `const target = document.activeElement || document.body; pressKey(target, ${JSON.stringify(combo)}); if ((${JSON.stringify(combo)}.includes('Control') || ${JSON.stringify(combo)}.includes('Meta')) && target !== window) pressKey(window, ${JSON.stringify(combo)}); return true`),
    insertText: (text) => this.invoke(this.mainId, `const target = document.activeElement || document.body;
      if (typeof target.focus === 'function') target.focus();
      const inserted = document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(text)});
      if (!inserted) {
        target.dispatchEvent(new InputEvent('beforeinput', { data: ${JSON.stringify(text)}, inputType: 'insertText', bubbles: true, cancelable: true }));
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
          const start = target.selectionStart ?? target.value.length
          const end = target.selectionEnd ?? start
          const next = target.value.slice(0, start) + ${JSON.stringify(text)} + target.value.slice(end)
          const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(target, next)
          if (target._valueTracker) target._valueTracker.setValue('__awb_previous__')
          target.selectionStart = target.selectionEnd = start + ${JSON.stringify(text)}.length
          target.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(text)}, inputType: 'insertText', bubbles: true }))
        }
      }
      return true`),
    type: async (text) => {
      for (const char of text) {
        await this.invoke(this.mainId, `const target = document.activeElement || document.body;
          const init = { key: ${JSON.stringify(char)}, bubbles: true, cancelable: true };
          target.dispatchEvent(new KeyboardEvent('keydown', init));
          target.dispatchEvent(new InputEvent('beforeinput', { data: ${JSON.stringify(char)}, inputType: 'insertText', bubbles: true, cancelable: true }));
          target.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(char)}, inputType: 'insertText', bubbles: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', init));
          return true`)
      }
    },
  }

  async screenPoint(x, y) {
    const metrics = await this.evaluate(() => ({ dpr: devicePixelRatio, viewport: innerHeight }))
    const info = execFileSync('xwininfo', ['-name', 'Pello'], { encoding: 'utf8' })
    const number = (label) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1])
    const origin = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), height: number('Height') }
    const menu = origin.height - metrics.viewport * metrics.dpr
    return { x: Math.round(origin.x + x * metrics.dpr), y: Math.round(origin.y + menu + y * metrics.dpr) }
  }

  mouse = {
    move: async (x, y) => {
      const point = await this.screenPoint(x, y)
      this.pointer = point
      execFileSync('xdotool', ['mousemove', String(point.x), String(point.y)])
    },
    down: async () => { execFileSync('xdotool', ['mousedown', '1']) },
    up: async () => { execFileSync('xdotool', ['mouseup', '1']) },
    click: async (x, y) => {
      const point = await this.screenPoint(x, y)
      this.pointer = point
      execFileSync('xdotool', ['mousemove', String(point.x), String(point.y), 'click', '1'])
    },
    wheel: (deltaX, deltaY) => this.evaluate((payload) => {
      if (window.__awbHoverFrame) {
        const frame = document.querySelector('iframe')
        if (frame && frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'awb-eval', id: 0, source: `document.documentElement.dispatchEvent(new WheelEvent('wheel', { deltaX: ${payload.deltaX}, deltaY: ${payload.deltaY}, ctrlKey: ${payload.ctrl}, bubbles: true, cancelable: true }))` }, '*')
          return true
        }
      }
      const target = window.__awbHover && window.__awbHover.isConnected ? window.__awbHover : document.body
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: payload.deltaX, deltaY: payload.deltaY, deltaMode: 0, ctrlKey: payload.ctrl, bubbles: true, cancelable: true }))
      return true
    }, { deltaX, deltaY, ctrl: !!this.ctrl }),
  }

  clock = {
    install: ({ time }) => this.evaluate((iso) => {
      const state = { now: new Date(iso).getTime(), seq: 1, queue: [] }
      const nativeSet = window.setTimeout.bind(window)
      const nativeClear = window.clearTimeout.bind(window)
      window.__awbClock = state
      window.__awbNativeTimeout = nativeSet
      const arm = (fn, delay, repeat) => {
        const wait = Number(delay) || 0
        if (wait < 1500) return nativeSet(fn, wait)
        const id = 1_000_000_000 + state.seq++
        state.queue.push({ id, fn, delay: wait, at: state.now + wait, repeat })
        return id
      }
      window.setTimeout = (fn, delay, ...args) => arm(() => fn(...args), delay, false)
      window.setInterval = (fn, delay, ...args) => arm(() => fn(...args), delay, true)
      const clear = (id) => {
        const before = state.queue.length
        state.queue = state.queue.filter((item) => item.id !== id)
        if (state.queue.length === before) nativeClear(id)
      }
      window.clearTimeout = clear
      window.clearInterval = clear
      Date.now = () => state.now
      window.__awbAdvance = (ms) => {
        const target = state.now + ms
        const due = state.queue.filter((item) => item.at <= target).sort((a, b) => a.at - b.at)
        state.queue = state.queue.filter((item) => item.at > target)
        state.now = target
        for (const item of due) {
          if (item.repeat) state.queue.push({ id: item.id, fn: item.fn, delay: item.delay, at: state.now + item.delay, repeat: true })
          item.fn()
        }
      }
      return true
    }, time.toISOString()),
    pauseAt: (date) => this.evaluate((iso) => { window.__awbClock.now = new Date(iso).getTime(); return true }, date.toISOString()),
    fastForward: (ms) => this.evaluate((amount) => { window.__awbAdvance(amount); return true }, ms),
  }

  locator(selector) { return new Locator(this, [{ selector }]) }
  getByRole(role, options = {}) { return new Locator(this, [{ role, name: options.name, exact: options.exact }]) }
  getByLabel(name, options = {}) { return new Locator(this, [{ label: name, exact: options.exact }]) }
  getByText(text, options = {}) { return new Locator(this, [{ text, exact: options.exact }]) }
  frameLocator(selector) { return new Locator(this, [{ frame: selector }]) }

  async click(selector) { return this.locator(selector).click() }

  async screenshot({ path: file } = {}) {
    const size = await this.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const message = await this.sendInner(this.mainId, 'Page.snapshotRect', { x: 0, y: 0, width: size.width, height: size.height, coordinateSystem: 'Viewport' })
    const buffer = decodePng(message.result?.dataURL)
    if (file) fs.writeFileSync(file, buffer)
    return buffer
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.errorTimer)
    for (const timer of this.frameTimers || []) clearInterval(timer)
    for (const [id, resolve] of this.pendingOuter) {
      this.pendingOuter.delete(id)
      resolve({ result: {} })
    }
    for (const [id, resolve] of this.pendingInner) {
      this.pendingInner.delete(id)
      resolve({ result: { result: { value: null } } })
    }
    try { this.ws.close() } catch { /* The socket may already be closed. */ }
  }
}

class Locator {
  constructor(page, steps, index = null) {
    this.page = page
    this.steps = steps
    this.index = index
  }

  async run(body, arg, hasArg) {
    const located = await this.page.targetFor(this.steps)
    const steps = this.index == null ? located.steps : [...located.steps, { nth: this.index }]
    return this.page.invoke(located.targetId, `const steps = ${packValue(steps)}; ${body}`, arg, hasArg)
  }

  childSteps() { return this.index == null ? this.steps : [...this.steps, { nth: this.index }] }

  locator(selector) {
    if (selector === '..') return new Locator(this.page, [...this.childSteps(), { parent: true }])
    return new Locator(this.page, [...this.childSteps(), { selector }])
  }

  getByRole(role, options = {}) { return new Locator(this.page, [...this.childSteps(), { role, name: options.name, exact: options.exact }]) }
  getByLabel(name, options = {}) { return new Locator(this.page, [...this.childSteps(), { label: name, exact: options.exact }]) }
  getByText(text, options = {}) { return new Locator(this.page, [...this.childSteps(), { text, exact: options.exact }]) }

  filter(options) {
    const step = {}
    if (options.hasText != null) step.hasText = options.hasText
    if (options.has) step.hasSelector = options.has.steps.map((item) => item.selector).filter(Boolean).join(' ')
    return new Locator(this.page, [...this.childSteps(), step])
  }

  nth(index) { return new Locator(this.page, this.steps, index) }
  first() { return this.nth(0) }
  last() { return this.nth(-1) }

  async isVisible() {
    const last = await this.run(`const nodes = resolve(steps); return { count: nodes.length, visible: nodes.filter(visible).length }`)
    if (last.count > 1) throw new Error(`strict mode violation: ${last.count} matches for ${JSON.stringify(this.steps)}`)
    return last.visible === 1
  }

  async allTextContents() {
    return this.run(`return resolve(steps).map((el) => el.textContent || '')`)
  }

  async scrollIntoViewIfNeeded() {
    await this.waitFor({ state: 'attached' })
    return this.run(`const el = only(steps); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true`)
  }

  count() { return this.run(`return resolve(steps).length`) }

  async waitFor({ state = 'visible' } = {}) {
    const deadline = Date.now() + this.page.timeout
    let last = null
    while (Date.now() < deadline) {
      last = await this.run(`const nodes = resolve(steps); return { count: nodes.length, visible: nodes.filter(visible).length }`)
      if (last.count > 1 && state === 'visible') throw new Error(`strict mode violation: ${last.count} matches for ${JSON.stringify(this.steps)}`)
      if (state === 'detached' && last.count === 0) return
      if (state === 'visible' && last.visible === 1) return
      if (state === 'attached' && last.count > 0) return
      if (state === 'hidden' && last.visible === 0) return
      await sleep(30)
    }
    throw new Error(`Timed out waiting for ${state}: ${JSON.stringify(this.steps)} ${JSON.stringify(last)}`)
  }

  async click(options = {}) {
    await this.waitFor()
    const button = options.button || 'left'
    return this.run(`const el = only(steps); el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (${JSON.stringify(button)} === 'right') { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, view: window })); return true }
      const editable = el.closest('[contenteditable="true"]')
      if (editable) {
        editable.focus()
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      } else if (typeof el.focus === 'function') el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, view: window }));
      el.click();
      return true`)
  }

  async dblclick() {
    await this.waitFor()
    return this.run(`const el = only(steps); el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
      return true`)
  }

  async press(combo) {
    await this.waitFor()
    return this.run(`const el = only(steps); if (typeof el.focus === 'function') el.focus(); pressKey(el, ${JSON.stringify(combo)}); return true`)
  }

  async focus() {
    await this.waitFor()
    return this.run(`const el = only(steps); el.focus(); return true`)
  }

  async hover() {
    await this.waitFor()
    const box = await this.run(`const el = only(steps); el.scrollIntoView({ block: 'center', inline: 'center' });
      for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over'), cancelable: true, view: window }));
      const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: devicePixelRatio, viewport: innerHeight }`)
    // CSS :hover follows the pointer. A synthetic mouse event does not change it.
    const info = execFileSync('xwininfo', ['-name', 'Pello'], { encoding: 'utf8' })
    const number = (label) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1])
    const origin = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), height: number('Height') }
    const menu = origin.height - box.viewport * box.dpr
    const x = Math.round(origin.x + (box.x + box.width / 2) * box.dpr)
    const y = Math.round(origin.y + menu + (box.y + box.height / 2) * box.dpr)
    execFileSync('xdotool', ['mousemove', String(x), String(y)])
    return true
  }

  async osWheel(deltaX, deltaY) {
    const box = await this.run(`const el = only(steps); el.scrollIntoView({ block: 'center', inline: 'center' }); const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: devicePixelRatio, viewport: innerHeight }`)
    const info = execFileSync('xwininfo', ['-name', 'Pello'], { encoding: 'utf8' })
    const number = (label) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1])
    const origin = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), height: number('Height') }
    const menu = origin.height - box.viewport * box.dpr
    const x = Math.round(origin.x + (box.x + box.width / 2) * box.dpr)
    const y = Math.round(origin.y + menu + (box.y + Math.min(box.height / 2, 40)) * box.dpr)
    const down = (deltaY || deltaX) > 0
    const steps = Math.max(3, Math.round(Math.abs(deltaY || deltaX) / 40))
    for (let index = 0; index < steps; index += 1) {
      const args = ['mousemove', String(x), String(y)]
      if (deltaX) args.push('keydown', 'shift')
      args.push('click', down ? '5' : '4')
      if (deltaX) args.push('keyup', 'shift')
      execFileSync('xdotool', args)
    }
    return true
  }

  async fill(value) {
    await this.waitFor()
    return this.run(`await setValue(only(steps), ${JSON.stringify(value)}); return true`)
  }

  async selectOption(value) {
    await this.waitFor()
    return this.run(`await setValue(only(steps), ${JSON.stringify(value)}); return true`)
  }

  async inputValue() { await this.waitFor(); return this.run(`return only(steps).value`) }
  async isDisabled() { return this.run(`const el = only(steps); return !!el.disabled || el.getAttribute('aria-disabled') === 'true'`) }
  async isChecked() { return this.run(`return !!only(steps).checked`) }
  async check() {
    if (!(await this.isChecked())) await this.click()
  }
  async getAttribute(name) { return this.run(`const el = only(steps); return el.getAttribute(${JSON.stringify(name)})`) }
  async textContent() { return this.run(`return only(steps).textContent`) }
  async innerText() { return this.run(`return only(steps).innerText`) }

  async boundingBox() {
    return this.run(`const nodes = resolve(steps); const el = nodes[0]; if (!el) return null; const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }`)
  }

  async evaluate(fn, arg) {
    const hasArg = arguments.length > 1
    return this.run(`const el = only(steps); const fn = ${fn.toString()}; return ${hasArg ? 'fn(el, arg)' : 'fn(el)'};`, arg, hasArg)
  }

  async evaluateAll(fn, arg) {
    const hasArg = arguments.length > 1
    return this.run(`const nodes = resolve(steps); const fn = ${fn.toString()}; return ${hasArg ? 'fn(nodes, arg)' : 'fn(nodes)'};`, arg, hasArg)
  }

  async dispatchEvent(type, init = {}) {
    const eventInit = { bubbles: true, cancelable: true, ...init }
    const kind = type === 'keydown' || type === 'keyup' ? 'KeyboardEvent' : type === 'contextmenu' || type === 'click' || type === 'dblclick' ? 'MouseEvent' : 'Event'
    return this.run(`const el = only(steps); el.dispatchEvent(new ${kind}(${JSON.stringify(type)}, ${JSON.stringify(eventInit)})); return true`)
  }

  async screenshot() {
    const box = await this.run(`const el = only(steps); const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: devicePixelRatio, viewport: innerHeight }`)
    return grabWindow(box)
  }
}

function grabWindow(box) {
  const info = execFileSync('xwininfo', ['-name', 'Pello'], { encoding: 'utf8' })
  const number = (label) => Number(info.match(new RegExp(`${label}:\\s+(-?\\d+)`))?.[1])
  const origin = { x: number('Absolute upper-left X'), y: number('Absolute upper-left Y'), width: number('Width'), height: number('Height') }
  const screen = execFileSync('xdpyinfo', { encoding: 'utf8' }).match(/dimensions:\s+(\d+)x(\d+)/)
  const screenWidth = Number(screen[1])
  const screenHeight = Number(screen[2])
  const menu = origin.height - box.viewport * box.dpr
  let x = Math.round(origin.x + box.x * box.dpr)
  let y = Math.round(origin.y + menu + box.y * box.dpr)
  let width = Math.round(box.width * box.dpr)
  let height = Math.round(box.height * box.dpr)
  if (x < 0) { width += x; x = 0 }
  if (y < 0) { height += y; y = 0 }
  width = Math.min(width, screenWidth - x)
  height = Math.min(height, screenHeight - y)
  if (width < 1 || height < 1) throw new Error(`The webview element is outside the virtual display: ${JSON.stringify({ box, origin })}`)
  const file = path.join(os.tmpdir(), `pello-grab-${process.pid}-${Date.now()}.png`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${width}x${height}`, '-i', `${process.env.DISPLAY}.0+${x},${y}`, '-frames:v', '1', file])
  const png = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return png
}

function decodePng(dataUrl) {
  const encoded = String(dataUrl || '').split(',')[1]
  if (!encoded) throw new Error('WebKit snapshot did not return a PNG')
  return Buffer.from(encoded, 'base64')
}
