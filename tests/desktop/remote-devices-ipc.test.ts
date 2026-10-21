import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const handle = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { handle } }))
import { registerRemoteDevicesIpc } from '../../packages/desktop/src/main/remote-devices-ipc'
import type { DesktopRemoteDevices } from '../../packages/desktop/src/main/remote-devices'

beforeEach(() => handle.mockClear())

function setup(serverUrl: string | null = 'http://local:8748') {
  const frame = { url: `${serverUrl}/#/hermes/connections` }
  const mainContents = { mainFrame: frame } as unknown as WebContents
  const event = { sender: mainContents, senderFrame: frame }
  const context = { mainContents: mainContents as WebContents | null, serverUrl, recoveryUrl: 'data:text/html,controlled-failure-page' }
  const manager = { state: vi.fn(), add: vi.fn(), remove: vi.fn(), switchTo: vi.fn() }
  const devices = vi.fn(() => manager as unknown as DesktopRemoteDevices)
  registerRemoteDevicesIpc(devices, () => context)
  return { context, frame, event, devices, manager, handlers: new Map(handle.mock.calls) }
}

describe('desktop remote device IPC', () => {
  it.each(['http://local:8748', 'https://remote.example.com'])('allows management from the main Studio page at %s', async url => {
    const { handlers, event, manager } = setup(url)
    const input = { name: 'Home', serverUrl: 'http://home:6060' }
    handlers.get('hermes-desktop:remote-devices-list')!(event)
    expect(manager.state).toHaveBeenCalledOnce()
    handlers.get('hermes-desktop:remote-devices-add')!(event, input)
    expect(manager.add).toHaveBeenCalledWith(input)
    handlers.get('hermes-desktop:remote-devices-remove')!(event, 'id')
    expect(manager.remove).toHaveBeenCalledWith('id')
    await handlers.get('hermes-desktop:remote-devices-switch')!(event, 'id')
    expect(manager.switchTo).toHaveBeenLastCalledWith('id')
    await handlers.get('hermes-desktop:remote-devices-return-local')!(event)
    expect(manager.switchTo).toHaveBeenLastCalledWith(null)
  })

  it.each(['other-window', 'subframe', 'external-page', 'missing-window', 'unregistered-data-page'])('rejects every operation from %s before accessing state', kind => {
    const { handlers, event, context, frame, devices } = setup()
    if (kind === 'other-window') event.sender = { mainFrame: frame } as unknown as WebContents
    if (kind === 'subframe') event.senderFrame = { url: frame.url }
    if (kind === 'external-page') frame.url = 'https://external.example.com'
    if (kind === 'missing-window') context.mainContents = null
    if (kind === 'unregistered-data-page') frame.url = 'data:text/html,arbitrary'
    for (const handler of handlers.values()) expect(() => handler(event, 'id')).toThrow('main Studio window')
    expect(devices).not.toHaveBeenCalled()
  })

  it('permits only return-to-local from the exact desktop failure page when the server is unavailable', async () => {
    const { handlers, event, context, frame, manager, devices } = setup(null)
    frame.url = context.recoveryUrl
    for (const [channel, handler] of handlers) {
      if (channel.endsWith('return-local')) continue
      expect(() => handler(event, 'id')).toThrow('main Studio window')
    }
    expect(devices).not.toHaveBeenCalled()
    await handlers.get('hermes-desktop:remote-devices-return-local')!(event)
    expect(manager.switchTo).toHaveBeenCalledExactlyOnceWith(null)
  })
})
