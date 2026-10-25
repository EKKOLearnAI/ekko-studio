import { afterEach, expect, it, vi } from 'vitest'
import { copilotEnvironment } from '../../plugins/copilot/src/environment'
import type { AgentRuntimeContext } from '../../packages/studio-plugin-sdk/src'

const files = vi.hoisted(() => ({ exists: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: files.exists }))
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })
function context(text = '7.4.7', exit = 0) {
  let sequence = 0
  const dispose = vi.fn(async () => {}), spawn = vi.fn(async () => ({ dispose, read: async () => sequence++
    ? { chunks: [], truncated: false, exit: { code: exit, signal: null } }
    : { chunks: [{ stream: 'stdout', data: Buffer.from(text) }], truncated: false, exit: null } }))
  return { runtime: { signal: new AbortController().signal, processes: { spawn } } as unknown as AgentRuntimeContext, spawn, dispose }
}

it('does not require PowerShell outside Windows', async () => {
  const f = context()
  expect(await copilotEnvironment({ cwd: '/workspace' }, f.runtime, 'linux')).toEqual({})
  expect(f.spawn).not.toHaveBeenCalled()
})

it('checks native PowerShell and returns a single PATH override', async () => {
  const f = context(), path = 'D:\\Tools\\pwsh.exe'
  files.exists.mockImplementation(candidate => candidate === path)
  expect(await copilotEnvironment({ cwd: 'D:\\workspace', env: { Path: 'D:\\Tools;D:\\Other' } }, f.runtime, 'win32'))
    .toEqual({ PATH: 'D:\\Tools;D:\\Tools;D:\\Other' })
  expect(f.spawn).toHaveBeenCalledWith({ command: path, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], cwd: 'D:\\workspace' })
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('finds an MSI installation absent from PATH', async () => {
  const f = context(), expected = 'D:\\Apps\\PowerShell\\7\\pwsh.exe'
  files.exists.mockImplementation(path => path === expected)
  expect(await copilotEnvironment({ cwd: 'D:\\workspace', env: { ProgramFiles: 'D:\\Apps', PATH: '' } }, f.runtime, 'win32'))
    .toEqual({ PATH: 'D:\\Apps\\PowerShell\\7' })
})

it.each([['5.1.0', 0], ['not a version', 0], ['7.4.7', 1], ['7.4.7' + 'x'.repeat(16384), 0]] as const)('rejects old, failed or oversized PowerShell probes', async (text, exit) => {
  const f = context(text, exit), path = 'D:\\Tools\\pwsh.exe'
  files.exists.mockImplementation(candidate => candidate === path)
  await expect(copilotEnvironment({ cwd: 'D:\\workspace', env: { PATH: 'D:\\Tools' } }, f.runtime, 'win32')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('never launches a relative prerequisite path', async () => {
  const f = context(); files.exists.mockImplementation(path => path === 'relative\\pwsh.exe')
  await expect(copilotEnvironment({ cwd: 'D:\\workspace', env: { PATH: 'relative' } }, f.runtime, 'win32')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.spawn).not.toHaveBeenCalled()
})

it('disposes an in-flight prerequisite probe when its Run is cancelled', async () => {
  const f = context(), controller = new AbortController(), path = 'D:\\Tools\\pwsh.exe'
  f.spawn.mockResolvedValue({ dispose: f.dispose, read: async () => new Promise(() => {}) } as never)
  files.exists.mockImplementation(candidate => candidate === path)
  const pending = copilotEnvironment({ cwd: 'D:\\workspace', env: { PATH: 'D:\\Tools' } }, f.runtime, 'win32', controller.signal)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  controller.abort(new Error('Run cancelled'))
  await expect(pending).rejects.toThrow('Run cancelled')
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('bounds a hung PowerShell probe and confirms cleanup', async () => {
  vi.useFakeTimers()
  const f = context(), path = 'D:\\Tools\\pwsh.exe'
  f.spawn.mockResolvedValue({ dispose: f.dispose, read: async () => new Promise(() => {}) } as never)
  files.exists.mockImplementation(candidate => candidate === path)
  const pending = copilotEnvironment({ cwd: 'D:\\workspace', env: { PATH: 'D:\\Tools' } }, f.runtime, 'win32').catch(error => error)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await pending).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.dispose).toHaveBeenCalledOnce()
})
