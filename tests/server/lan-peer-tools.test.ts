import { afterEach, describe, expect, it, vi } from 'vitest'

describe('LAN peer tools service', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../packages/server/src/modules/studio/services/network/lan-peer-socket')
  })

  it('rejects remote tool calls on passive server-side peer connections', async () => {
    const execRemoteCommand = vi.fn()
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-peer-socket', () => ({
      getLanPeerSocketManager: () => ({
        getConnection: () => ({
          info: () => ({ role: 'server' }),
          execRemoteCommand,
        }),
      }),
    }))

    const { getLanPeerToolsService } = await import('../../packages/server/src/modules/studio/services/network/lan-peer-tools')

    expect(() => getLanPeerToolsService().exec({
      connectionId: 'server-side-connection',
      command: 'id',
    })).toThrow('Peer connection is not authorized for remote tools')
    expect(execRemoteCommand).not.toHaveBeenCalled()
  })

  it('allows remote tool calls on active client-side peer connections', async () => {
    const execRemoteCommand = vi.fn(async () => ({
      stdout: 'ok',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/network/lan-peer-socket', () => ({
      getLanPeerSocketManager: () => ({
        getConnection: () => ({
          info: () => ({ role: 'client' }),
          execRemoteCommand,
        }),
      }),
    }))

    const { getLanPeerToolsService } = await import('../../packages/server/src/modules/studio/services/network/lan-peer-tools')
    const result = await getLanPeerToolsService().exec({
      connectionId: 'client-side-connection',
      command: 'id',
      args: ['-u'],
    })

    expect(result.stdout).toBe('ok')
    expect(execRemoteCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'id',
      args: ['-u'],
    }))
  })
})
