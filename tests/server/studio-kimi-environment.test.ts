import { afterEach, expect, it, vi } from 'vitest'
import { kimiEnvironment } from '../../plugins/kimi/src/environment'
import type { AgentRuntimeContext } from '../../packages/studio-plugin-sdk/src'

const files = vi.hoisted(() => ({ exists: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: files.exists }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
function context(text = 'GNU bash, version 5.2', exit = 0) {
  let sequence = 0
  const dispose = vi.fn(async () => {}), spawn = vi.fn(async () => ({ dispose, read: async () => sequence++
    ? { chunks: [], truncated: false, exit: { code: exit, signal: null } }
    : { chunks: [{ stream: 'stdout', data: Buffer.from(text) }], truncated: false, exit: null } }))
  return { runtime: { signal: new AbortController().signal, processes: { spawn } } as unknown as AgentRuntimeContext, spawn, dispose }
}

it('does not probe Bash on other platforms', async () => {
  const f = context()
  expect(await kimiEnvironment({ cwd: '/workspace' }, f.runtime, 'linux')).toEqual({})
  expect(files.exists).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled()
})

it('accepts an explicit native Git Bash path only after the bounded version probe', async () => {
  const f = context(), path = 'C:\\Git\\bin\\bash.exe'
  files.exists.mockReturnValue(true)
  expect(await kimiEnvironment({ cwd: 'C:\\workspace', env: { KIMI_SHELL_PATH: `"${path}"` } }, f.runtime, 'win32')).toEqual({ KIMI_SHELL_PATH: path })
  expect(f.spawn).toHaveBeenCalledWith({ command: path, args: ['--version'], cwd: 'C:\\workspace' })
  expect(f.dispose).toHaveBeenCalledOnce()
})

it.each(['C:\\Windows\\System32\\bash.exe', 'C:\\Users\\u\\WindowsApps\\bash.exe', 'relative\\bash.exe'])('rejects unsupported Bash path %s without launching it', async path => {
  const f = context(); files.exists.mockReturnValue(true)
  await expect(kimiEnvironment({ cwd: 'C:\\workspace', env: { KIMI_SHELL_PATH: path } }, f.runtime, 'win32')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.spawn).not.toHaveBeenCalled()
})

it('discovers a working Git Bash from Windows roots rather than a WSL launcher', async () => {
  const f = context(), expected = 'D:\\Apps\\Git\\usr\\bin\\bash.exe'
  files.exists.mockImplementation(path => path === expected)
  expect(await kimiEnvironment({ cwd: 'D:\\workspace', env: { ProgramFiles: 'D:\\Apps' } }, f.runtime, 'win32')).toEqual({ KIMI_SHELL_PATH: expected })
  expect(f.spawn).toHaveBeenCalledOnce()
})

it.each([['not a GNU shell', 0], ['GNU bash', 1], ['GNU bash' + 'x'.repeat(16384), 0]] as const)('rejects an invalid or oversized Bash probe', async (text, exit) => {
  const f = context(text, exit); files.exists.mockReturnValue(true)
  await expect(kimiEnvironment({ cwd: 'C:\\workspace', env: { KIMI_SHELL_PATH: 'C:\\Git\\bash.exe' } }, f.runtime, 'win32')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('stops an outstanding Bash probe when its Run is cancelled', async () => {
  const f = context(), controller = new AbortController()
  f.spawn.mockResolvedValue({ dispose: f.dispose, read: async () => new Promise(() => {}) } as never)
  files.exists.mockReturnValue(true)
  const pending = kimiEnvironment({ cwd: 'C:\\workspace', env: { KIMI_SHELL_PATH: 'C:\\Git\\bash.exe' } }, f.runtime, 'win32', controller.signal)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  controller.abort(new Error('Run cancelled'))
  await expect(pending).rejects.toThrow('Run cancelled')
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('bounds a hung Bash version check and confirms disposal before reporting failure', async () => {
  vi.useFakeTimers()
  const f = context()
  f.spawn.mockResolvedValue({ dispose: f.dispose, read: async () => new Promise(() => {}) } as never)
  files.exists.mockReturnValue(true)
  const pending = kimiEnvironment({ cwd: 'C:\\workspace', env: { KIMI_SHELL_PATH: 'C:\\Git\\bash.exe' } }, f.runtime, 'win32').catch(error => error)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.dispose).toHaveBeenCalledOnce()
})
