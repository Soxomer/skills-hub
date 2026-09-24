import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(tmpdir(), 'ahm-lifecycle-'))
const binary = resolve(process.argv[2] ?? `target/debug/ahm${process.platform === 'win32' ? '.exe' : ''}`)
const state = join(root, 'runner.db')
const prefix = ['--db', join(root, 'library.db'), '--runner-state', state]
const home = join(root, 'home')
await mkdir(home)
await writeFile(join(home, 'KEEP.txt'), 'untouched')
let offline = false, held = null, holdNext = false
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume bounded test request */ }
  if (request.url === '/runner/v1/enroll') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ organizationId: 'org_fixture', deviceId: 'device_fixture', credential: 'disposable-fixture-credential' }))
  } else if (request.url === '/runner/v1/jobs/claim') {
    if (holdNext) { held = response; holdNext = false; return }
    await delay(100)
    response.writeHead(offline ? 503 : 204).end()
  } else response.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const run = args => new Promise((resolve, reject) => {
  const child = spawn(binary, [...prefix, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.resume()
  child.on('error', reject)
  child.on('exit', code => resolve({ code, output }))
})
const waitFor = async (predicate, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await predicate()) return; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
const status = async () => JSON.parse((await run(['worker', '--status'])).output)
let worker
try {
  assert.equal((await status()).configured, false, 'fresh installation needs connection')
  assert.equal((await run(['connect', 'fixture-code', '--server', origin])).code, 0)
  const enrolled = await status()
  assert.equal(enrolled.configured, true, 'saved identity survives helper restarts')
  assert.ok(!JSON.stringify(enrolled).includes('disposable-fixture-credential'), 'status never exposes credentials')
  worker = spawn(binary, [...prefix, 'worker', '--home', home, '--poll-seconds', '1'], { windowsHide: true, stdio: 'ignore' })
  await waitFor(async () => (await status()).report?.state === 'connected', 'connected')
  assert.notEqual((await run(['worker', '--once', '--home', home])).code, 0, 'second worker rejected')
  assert.notEqual((await run(['connect', 'fixture-code', '--server', origin])).code, 0, 'cannot replace credentials while worker active')
  offline = true
  await waitFor(async () => (await status()).report?.state === 'offline', 'network failure shown')
  offline = false
  await waitFor(async () => (await status()).report?.state === 'connected', 'automatic reconnect')
  holdNext = true
  await waitFor(() => held !== null, 'in-flight poll')
  assert.equal((await run(['worker', '--stop'])).code, 0)
  assert.equal((await status()).running, true, 'stop must not kill current cycle')
  held.writeHead(204).end(); held = null
  await waitFor(async () => !(await status()).running, 'graceful stop')
  assert.equal((await status()).report.state, 'stopped')
  assert.equal((await run(['worker', '--once', '--home', home])).code, 0, 'restart with existing credential')
  assert.equal(await readFile(join(home, 'KEEP.txt'), 'utf8'), 'untouched')
  console.log('Worker lifecycle passed: exclusive worker, reconnect guard, network recovery, drain/stop, restart, file preservation.')
} finally {
  if (held) held.writeHead(204).end()
  await run(['worker', '--stop', '--wait'])
  if (worker && worker.exitCode === null) worker.kill()
  server.closeAllConnections()
  server.close()
}
