import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedProcessScope, parseProcessSpawn } from '../../packages/server/src/modules/studio/services/processes/managed'
import type { ProcessHandle } from '../../packages/studio-plugin-sdk/src'
import { StudioError } from '../../packages/studio-plugin-sdk/src'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const nativePty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
function readyMetadata(output: string) {
  const text = stripVTControlCharacters(output).replace(/[\r\n]/g, '')
  return JSON.parse(text.match(/\{"ready":true[^{}]*\}/)![0])
}
const program = `process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, tty: process.stdin.isTTY, cols: process.stdout.columns, rows: process.stdout.rows, secret: !!process.env.OPENAI_API_KEY }) + '\\n');
process.stdout.on('resize', () => process.stdout.write('SIZE:' + process.stdout.columns + ':' + process.stdout.rows + '\\n'));
process.stderr.write('MERGED-STDERR\\n');
process.stdin.on('data', data => { process.stdout.write('ECHO:' + data.toString('utf8') + '\\n'); });`
async function setup(code = program) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-pty-中文 ')), controller = new AbortController()
  let allowed = true
  const scope = new ManagedProcessScope(controller.signal, () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') })
  close.push(() => rm(directory, { recursive: true, force: true }), () => scope.close())
  const handle = await scope.api.spawn({ command: process.execPath, args: ['-e', code], cwd: directory, terminal: { cols: 90, rows: 30 } })
  return { handle, scope, controller, revoke: () => { allowed = false } }
}
async function until(handle: ProcessHandle, marker: string) {
  const decoder = new TextDecoder(), chunks: string[] = []
  await vi.waitFor(async () => {
    const batch = await handle.read()
    expect(batch.chunks.length).toBeLessThanOrEqual(4)
    expect(batch.chunks.every(chunk => chunk.data.length <= 16_384)).toBe(true)
    expect(batch.chunks.every(chunk => chunk.stream === 'stdout')).toBe(true)
    chunks.push(...batch.chunks.map(chunk => decoder.decode(chunk.data, { stream: true })))
    expect(chunks.join('')).toContain(marker)
  }, { interval: 10, timeout: 2000 })
  return chunks.join('')
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }

it('allocates a real TTY with byte IO, explicit size and merged stderr', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'must-not-be-inherited')
  const f = await setup(), output = await until(f.handle, 'MERGED-STDERR')
  const ready = readyMetadata(output)
  expect(ready).toMatchObject({ ready: true, tty: true, cols: 90, rows: 30, secret: false })
  await f.handle.write(Buffer.from('中文😀'))
  expect(await until(f.handle, 'ECHO:中文😀')).toContain('ECHO:中文😀')
  await expect(f.handle.end()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await f.scope.close(); expect(alive(ready.pid)).toBe(false)
})

it('resizes the owned terminal and refuses invalid dimensions', async () => {
  const f = await setup()
  await until(f.handle, 'MERGED-STDERR')
  await f.handle.resize!(110, 35)
  expect(await until(f.handle, 'SIZE:110:35')).toContain('SIZE:110:35')
  await expect(f.handle.resize!(0, 35)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it.each(['cancel', 'revoke'])('reaps a terminal and rejects new IO after %s', async action => {
  const f = await setup(), ready = readyMetadata(await until(f.handle, 'MERGED-STDERR'))
  if (action === 'cancel') f.controller.abort(); else f.revoke()
  await expect(f.handle.write(Buffer.from('not sent'))).rejects.toBeInstanceOf(StudioError)
  await f.scope.close()
  expect(alive(ready.pid)).toBe(false)
})

it('bounds cumulative PTY input when the native API cannot confirm write drainage', async () => {
  const spawn = nativePty.spawn, writes = vi.fn()
  vi.spyOn(nativePty, 'spawn').mockImplementationOnce((...args) => {
    const terminal = spawn(...args)
    // This boundary deliberately supplies no drain receipt, as in node-pty.
    // Admission must stop before handing any extra bytes to the native writer.
    vi.spyOn(terminal, 'write').mockImplementation(writes)
    return terminal
  })
  const f = await setup(`process.stdin.setRawMode(true); process.stdin.pause(); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)`)
  await until(f.handle, 'READY')
  for (let n = 0; n < 16; n++) await f.handle.write(Buffer.alloc(65_536, 120))
  await expect(f.handle.write(Buffer.from('overflow'))).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  expect(writes).toHaveBeenCalledTimes(16)
  expect(writes.mock.calls.reduce((sum, [data]) => sum + Buffer.byteLength(data), 0)).toBe(1_048_576)
})

it('validates terminal options without accepting caller-selected ownership or extra fields', () => {
  const base = { command: 'node', args: [], cwd: process.cwd() }
  expect(parseProcessSpawn({ ...base, terminal: { cols: 80, rows: 24 } }).terminal).toEqual({ cols: 80, rows: 24 })
  for (const terminal of [null, {}, { cols: 0, rows: 24 }, { cols: 80, rows: 1001 }, { cols: 80, rows: 24, ownerId: 'forged' }]) {
    expect(() => parseProcessSpawn({ ...base, terminal })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
})

it('pauses terminal output for a slow reader and drains it through bounded byte windows', async () => {
  const spawn = nativePty.spawn, emitted: Buffer[] = []
  let emittedBytes = 0
  vi.spyOn(nativePty, 'spawn').mockImplementationOnce((...args) => {
    const terminal = spawn(...args)
    terminal.onData((data: string | Buffer) => { const bytes = Buffer.from(data); emitted.push(bytes); emittedBytes += bytes.length })
    return terminal
  })
  const f = await setup(`process.stdout.write('BEGIN\\n' + 'x'.repeat(524288) + '\\nEND\\n'); setInterval(() => {}, 1000)`)
  await new Promise(resolve => setTimeout(resolve, 40))
  let output = '', receivedBytes = 0
  const received: Buffer[] = []
  while (!output.includes('END') || receivedBytes < emittedBytes) {
    const batch = await f.handle.read()
    expect(batch.truncated).toBe(false)
    expect(batch.chunks.length).toBeLessThanOrEqual(4)
    for (const chunk of batch.chunks) {
      expect(chunk.data.length).toBeLessThanOrEqual(16_384)
      const data = Buffer.from(chunk.data); received.push(data); receivedBytes += data.length; output += data.toString('utf8')
    }
  }
  expect(Buffer.concat(received).equals(Buffer.concat(emitted))).toBe(true)
  // ConPTY emits a VT screen update stream, including redraws, rather than an
  // exact copy of stdout. Both platforms must preserve their native byte stream.
  if (process.platform !== 'win32') expect(output.split('x').length - 1).toBe(524288)
})

it('terminates descendants in the owned PTY process group', async () => {
  const f = await setup(`const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write('CHILD:' + child.pid + '\\n'); setInterval(() => {}, 1000)`)
  const output = await until(f.handle, 'CHILD:'), childPid = Number(output.match(/CHILD:(\d+)/)![1])
  expect(alive(childPid)).toBe(true)
  await f.scope.close()
  await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 2000 })
})
