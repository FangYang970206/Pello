import assert from 'node:assert/strict'
import http from 'node:http'
import { readMcpStatus } from './opencode-mcp-list.mjs'

let initialized = false, polls = 0, failInitialization = false
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  assert.equal(url.searchParams.get('location[directory]'), '/home/tester/中文 project')
  if (request.headers.authorization !== 'Basic fixture') { response.writeHead(401).end(); return }
  response.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/api/agent') {
    if (failInitialization) { response.writeHead(503).end(); return }
    initialized = true
    response.end(JSON.stringify({ data: [{ name: 'Build' }] }))
  } else if (url.pathname === '/api/mcp') {
    response.end(JSON.stringify({ data: initialized ? [{ name: 'fixture', status: { status: ++polls > 1 ? 'connected' : 'pending' } }] : [] }))
  } else response.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
try {
  const result = await readMcpStatus(url, '/home/tester/中文 project', { Authorization: 'Basic fixture' }, 2000)
  assert.deepEqual(result.map(({ name, status }) => [name, status.status]), [['fixture', 'connected']], 'A cold service must initialize Agent configuration before listing MCP')
  initialized = false; failInitialization = true
  await assert.rejects(readMcpStatus(url, '/home/tester/中文 project', { Authorization: 'Basic fixture' }, 2000), /HTTP 503/, 'Initialization errors must not become a false empty list')
  await assert.rejects(readMcpStatus(url, '/home/tester/中文 project', {}, 2000), /HTTP 401/)
  console.log('PASS cold OpenCode MCP queries initialize native Agent configuration, await connections, preserve directory context and report errors')
} finally { await new Promise((resolve) => server.close(resolve)) }
