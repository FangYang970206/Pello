import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { parseArgs } from 'node:util'

/** Query native connection state. A cold OpenCode service needs its Agent config initialized first. */
export async function readMcpStatus(baseUrl, directory, headers, timeout = 30000) {
  const deadline = Date.now() + timeout
  async function get(endpoint) {
    const url = new URL(endpoint, baseUrl)
    url.searchParams.set('location[directory]', directory)
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    if (!response.ok) throw new Error(`OpenCode ${endpoint}: HTTP ${response.status}`)
    const result = await response.json()
    return result.data ?? result
  }
  // MCP configuration is applied by OpenCode's Agent/config plugins. Querying
  // /api/mcp alone on a fresh private service returns an uninitialized empty list.
  await get('/api/agent')
  let servers
  do {
    servers = await get('/api/mcp')
    if (!Array.isArray(servers)) throw new Error('OpenCode returned an invalid MCP server list')
    if (!servers.some((server) => server.status?.status === 'pending')) return servers
    if (Date.now() >= deadline) return servers
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return servers
}

export async function listOpenCodeMcp({ executable, directory = process.cwd(), timeout = 30000 }) {
  const password = randomUUID()
  const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password }
  })
  let output = '', startupError, closed = false
  const completion = new Promise((resolve) => child.once('close', () => { closed = true; resolve() }))
  child.once('error', (error) => { startupError = error })
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-65536) })
  child.stderr.resume()
  try {
    const deadline = Date.now() + timeout
    let baseUrl
    while (!baseUrl) {
      if (startupError) throw new Error(`Cannot start OpenCode: ${startupError.code || 'spawn failed'}`)
      if (closed) throw new Error('OpenCode exited before its private server became ready')
      for (const line of output.split('\n')) {
        try {
          const value = JSON.parse(line)
          if (value.url) {
            const url = new URL(value.url)
            if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password) baseUrl = url.href
          }
        } catch { /* Startup output may contain incomplete lines. */ }
      }
      if (Date.now() >= deadline) throw new Error('OpenCode private server startup timed out')
      if (!baseUrl) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
    return await readMcpStatus(baseUrl, directory, headers, timeout)
  } finally {
    child.stdin.end()
    const stopped = await Promise.race([completion.then(() => true), new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      timer.unref()
    })])
    if (!stopped && !closed && child.pid) {
      if (process.platform === 'win32') await new Promise((resolve) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
      else child.kill('SIGTERM')
      await Promise.race([completion, new Promise((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref() })])
      if (!closed) child.kill('SIGKILL')
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { executable: { type: 'string' }, directory: { type: 'string' }, name: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } })
    if (values.help) {
      console.log('Usage: npm run mcp:opencode -- [--directory PATH] [--executable FILE] [--name SERVER] [--timeout MS] [--json]')
    } else {
      const timeout = Number(values.timeout || 30000)
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error('timeout must be between 1 and 300000 ms')
      const executable = values.executable || (process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'npm/node_modules/@opencode/cli/bin/opencode.exe') : 'opencode')
      const servers = await listOpenCodeMcp({ executable, directory: path.resolve(values.directory || '.'), timeout })
      const result = servers.filter((server) => !values.name || server.name === values.name).map(({ name, status }) => ({ name, status: status?.status || 'unknown' }))
      if (values.name && !result.length) throw new Error(`MCP server not found: ${values.name}`)
      console.log(values.json ? JSON.stringify(result, null, 2) : result.map((server) => `${server.name}  ${server.status}`).join('\n') || 'No MCP servers configured')
      if (result.some((server) => !['connected', 'disabled'].includes(server.status))) process.exitCode = 1
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
