import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ManagedProcessScope, managedProcessEnvironment, parseProcessSpawn } from '../../packages/server/src/modules/studio/services/processes/managed'
import { StudioError, type ProcessHandle } from '../../packages/studio-plugin-sdk/src'

let root: string
const scopes: ManagedProcessScope[] = []
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'studio-process-中文 ')) })
afterEach(async () => { await Promise.all(scopes.splice(0).map(scope => scope.close())); vi.unstubAllEnvs() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
function setup(authorize = () => {}) {
  const controller = new AbortController(), scope = new ManagedProcessScope(controller.signal, authorize)
  scopes.push(scope)
  const spawn = (code: string, args: string[] = []) => scope.api.spawn({ command: process.execPath, args: ['-e', code, ...args], cwd: root })
  return { controller, scope, spawn }
}
async function drain(handle: ProcessHandle) {
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  while (true) {
    const result = await handle.read()
    expect(result.chunks.length).toBeLessThanOrEqual(4)
    for (const chunk of result.chunks) {
      expect(chunk.data.length).toBeLessThanOrEqual(16_384)
      ;(chunk.stream === 'stdout' ? stdout : stderr).push(Buffer.from(chunk.data))
    }
    if (result.exit && result.chunks.length === 0) return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exit: result.exit, truncated: result.truncated }
  }
}
function alive(pid: number): boolean {
  try {
    if (process.platform === 'linux' && /State:\s+Z/.test(readFileSync(`/proc/${pid}/status`, 'utf8'))) return false
    process.kill(pid, 0); return true
  } catch { return false }
}

it('preserves literal Unicode/metacharacter arguments and binary stdin across a real process', async () => {
  const { spawn } = setup()
  const args = ['中文 "quoted" & | < > ^ %PATH% !x! $HOME `whoami`', 'two\nlines', 'trailing\\']
  const process = await spawn(`process.stderr.write(JSON.stringify(process.argv.slice(1))); process.stdin.pipe(process.stdout)`, args)
  const bytes = Uint8Array.from([0, 255, 128, 65, 10, 13, 195, 169])
  await process.write(bytes); bytes.fill(0); await process.end()
  const result = await drain(process)
  expect([...result.stdout]).toEqual([0, 255, 128, 65, 10, 13, 195, 169])
  expect(JSON.parse(result.stderr.toString())).toEqual(args)
  expect(result.exit).toEqual({ code: 0, signal: null }); expect(result.truncated).toBe(false)
  await process.dispose(); await process.dispose()
  await expect(process.read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('drains output larger than the buffer without truncation and keeps stdout/stderr distinct', async () => {
  const { spawn } = setup(), handle = await spawn(`process.stderr.write('diagnostic'); process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 231))`)
  const result = await drain(handle)
  expect(result.stdout.equals(Buffer.alloc(4 * 1024 * 1024, 231))).toBe(true)
  expect(result.stderr.toString()).toBe('diagnostic')
  expect(result.truncated).toBe(false)
})

it('does not inherit application credentials or Node injection options and forces Electron Node mode', async () => {
  expect(managedProcessEnvironment({ Path: 'inherited', SystemRoot: 'windows' }, { path: 'explicit', electron_run_as_node: '0' }, 'win32'))
    .toEqual({ PATH: 'explicit', SYSTEMROOT: 'windows', ELECTRON_RUN_AS_NODE: '1' })
  expect(managedProcessEnvironment({ PATH: '/bin', HOME: '/home', NODE_OPTIONS: '--inspect', AUTH_TOKEN: 'secret', OPENAI_API_KEY: 'secret', HERMES_PROFILE: 'private', ELECTRON_RUN_AS_NODE: '0' }, { CUSTOM: 'value', ELECTRON_RUN_AS_NODE: '0' }))
    .toEqual({ PATH: '/bin', HOME: '/home', CUSTOM: 'value', ELECTRON_RUN_AS_NODE: '1' })
  vi.stubEnv('STUDIO_PROCESS_PARENT_SECRET', 'must-not-inherit')
  const { scope } = setup()
  const handle = await scope.api.spawn({ command: process.execPath, args: ['-e', `console.log(JSON.stringify({ secret: process.env.STUDIO_PROCESS_PARENT_SECRET || null, literal: process.env.LITERAL, electron: process.env.ELECTRON_RUN_AS_NODE }))`], cwd: root, env: { LITERAL: 'literal value', ELECTRON_RUN_AS_NODE: '0' } })
  expect(JSON.parse((await drain(handle)).stdout.toString())).toEqual({ secret: null, literal: 'literal value', electron: '1' })
})

it('rejects forged host options and malformed inputs before spawning', () => {
  const valid = { command: process.execPath, args: [], cwd: root }
  for (const value of [{ ...valid, shell: true }, { ...valid, ownerId: 'other' }, { ...valid, cwd: 'relative' }, { ...valid, args: [null] }, { ...valid, args: ['bad\0argument'] },
    { ...valid, command: '' }, { ...valid, env: { 'INVALID=KEY': 'value' } }, { ...valid, env: { TOKEN: 123 } }]) {
    expect(() => parseProcessSpawn(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
  expect(() => parseProcessSpawn({ ...valid, command: 'cli.cmd', args: ['line\nnext'] }, 'win32')).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
})

it.runIf(process.platform === 'win32')('uses a Windows CLI shim without executing argument metacharacters', async () => {
  const { scope } = setup(), command = join(root, 'echo args.cmd'), script = join(root, 'echo.cjs')
  await writeFile(command, `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`)
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const args = ['中文 space', 'literal & echo injected', 'literal|pipe', '%PATH%', 'quoted "value"']
  const child = await scope.api.spawn({ command, args, cwd: root })
  const output = await drain(child)
  expect(output.exit.code).toBe(0)
  expect(JSON.parse(output.stdout.toString())).toEqual(args)
})

it('sanitizes launch failure and can launch a subsequent process', async () => {
  const { scope, spawn } = setup()
  await expect(scope.api.spawn({ command: join(root, 'missing-secret-executable'), args: [], cwd: root })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', message: 'Managed process could not start' })
  expect((await drain(await spawn('process.stdout.write("ok")'))).stdout.toString()).toBe('ok')
})

it('rejects simultaneous readers and oversized writes, and wakes a pending reader on disposal', async () => {
  const { spawn } = setup(), handle = await spawn('setInterval(() => {}, 1000)')
  const pending = handle.read(); void pending.catch(() => {})
  await expect(handle.read()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(handle.write(new Uint8Array(65_537))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await handle.dispose()
  await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('rechecks authority and kills an owned process when permission is revoked', async () => {
  let allowed = true
  const { scope, spawn } = setup(() => { if (!allowed) throw new StudioError('FORBIDDEN', 'Revoked') })
  const handle = await spawn('process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)')
  let batch = await handle.read()
  while (!batch.chunks.length && !batch.exit) batch = await handle.read()
  const pid = Number(Buffer.concat(batch.chunks.map(chunk => Buffer.from(chunk.data))).toString())
  expect(alive(pid)).toBe(true); allowed = false
  await expect(handle.read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await scope.close(); expect(alive(pid)).toBe(false)
})

it('cancels a scope before launch without starting a child', async () => {
  const { controller, spawn } = setup(); controller.abort()
  await expect(spawn('throw new Error("must not execute")')).rejects.toMatchObject({ code: 'CANCELLED' })
})

it('closes unread output and escalates a process that ignores graceful termination', async () => {
  const { controller, scope, spawn } = setup(), path = join(root, 'unread-pid')
  await spawn(`require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); process.stdout.write(Buffer.alloc(4 * 1024 * 1024)); setInterval(() => {}, 1000)`, [path])
  let pid = 0
  await vi.waitFor(async () => { pid = Number(await readFile(path, 'utf8')); expect(alive(pid)).toBe(true) })
  controller.abort(); await scope.close()
  expect(alive(pid)).toBe(false)
})

it('terminates descendants in the owned process tree', async () => {
  const { scope, spawn } = setup(), path = join(root, 'descendant-pids')
  const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  await spawn(`const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
    require('node:fs').writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid])); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`, [path])
  let pids: number[] = []
  await vi.waitFor(async () => { pids = JSON.parse(await readFile(path, 'utf8')); expect(pids.every(alive)).toBe(true) })
  await scope.close()
  await vi.waitFor(() => expect(pids.map(alive)).toEqual([false, false]))
})
