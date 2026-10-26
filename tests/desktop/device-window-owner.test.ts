import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { deviceWindowEndpoint, ownDeviceWindow } from '../../packages/desktop/src/main/device-window-owner'
it('reuses a live device owner and permits reopening after it exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'device-owner-'))
  const endpoint = deviceWindowEndpoint(root, 'https://nas.test')
  const focus = vi.fn()
  const release = await ownDeviceWindow(endpoint, focus)
  try {
    expect(release).toBeTypeOf('function')
    expect(await ownDeviceWindow(endpoint, vi.fn())).toBeNull()
    expect(focus).toHaveBeenCalledOnce()
    release!()
    await new Promise(resolve => setTimeout(resolve, 30))
    const reopened = await ownDeviceWindow(endpoint, focus)
    expect(reopened).toBeTypeOf('function');reopened!()
  } finally { release?.();rmSync(root, { recursive: true, force: true }) }
})

it('recovers a Unix socket left by a killed owner', async () => {
  if (process.platform === 'win32') return
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const root = mkdtempSync(join(tmpdir(), 'device-crash-'))
  const endpoint = deviceWindowEndpoint(root, 'https://nas.test')
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(endpoint)},()=>console.log('ready'))`], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    child.kill('SIGKILL');await once(child, 'close')
    const release = await ownDeviceWindow(endpoint, vi.fn())
    expect(release).toBeTypeOf('function');release!()
  } finally {child.kill();rmSync(root,{recursive:true,force:true})}
})

it('keeps Electron argument delivery ahead of cross-userData device focusing', () => {
  const source = readFileSync('packages/desktop/src/main/index.ts', 'utf8')
  expect(source.indexOf('app.requestSingleInstanceLock(')).toBeLessThan(source.indexOf('const releaseDevice = await ownDeviceWindow('))
  expect(source.indexOf("app.on('second-instance'")).toBeLessThan(source.indexOf('const releaseDevice = await ownDeviceWindow('))
})
