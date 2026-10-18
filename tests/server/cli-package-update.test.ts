import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  vi.doUnmock('fs')
  vi.doUnmock('child_process')
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('CLI npm package updates', () => {
  it.each([
    ['ekko-studio', 'darwin'], ['hermes-web-ui', 'darwin'],
    ['ekko-studio', 'win32'], ['hermes-web-ui', 'win32'],
  ])('updates and restarts %s on %s without using a shared command shim', async (name, platform) => {
    vi.resetModules()
    Object.defineProperty(process, 'platform', { value: platform })
    const install = new EventEmitter()
    const restart = new EventEmitter()
    const spawn = vi.fn().mockReturnValueOnce(install).mockReturnValueOnce(restart)
    const globalRoot = resolve('fixture-global-node-modules')
    const execFileSync = vi.fn((_command, args) => args.includes('root') ? globalRoot : '')
    vi.doMock('child_process', () => ({ execFileSync, execSync: vi.fn(), spawn }))
    vi.doMock('fs', async importOriginal => {
      const actual = await importOriginal<typeof import('fs')>()
      return {
        ...actual,
        existsSync: (path: string) => path === join(globalRoot, name, 'bin', 'hermes-web-ui.mjs') || actual.existsSync(path),
        readFileSync: (path: string, encoding: any) => path === resolve('package.json')
          ? JSON.stringify({ name, version: '0.7.23' }) : actual.readFileSync(path, encoding),
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { doUpdate } = await import('../../bin/hermes-web-ui.mjs')
    doUpdate()
    if (platform === 'win32') {
      expect(spawn).toHaveBeenCalledWith(expect.any(String), ['/d', '/s', '/c', expect.stringContaining(`install -g ${name}@latest`)], expect.any(Object))
    } else {
      expect(spawn).toHaveBeenCalledWith(expect.any(String), ['install', '-g', `${name}@latest`], expect.any(Object))
    }
    install.emit('exit', 0)
    expect(execFileSync).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['root', '-g']), expect.any(Object))
    if (platform === 'win32') {
      expect(execFileSync).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('npm-cli.js'), 'root', '-g'], expect.any(Object))
    }
    expect(spawn).toHaveBeenLastCalledWith(process.execPath,
      [join(globalRoot, name, 'bin', 'hermes-web-ui.mjs'), 'restart', '--port', expect.any(String)],
      expect.objectContaining({ windowsHide: true }))
  })
})
