import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploymentBasePath, deploymentUrl, socketEndpoint } from '../../packages/client/src/utils/deployment-url'

afterEach(() => vi.unstubAllEnvs())

describe('portal deployment URLs', () => {
  it('leaves root installations and external assets unchanged', () => {
    vi.stubEnv('BASE_URL', '/')
    expect(deploymentBasePath()).toBe('')
    expect(deploymentUrl('/logo.png')).toBe('/logo.png')
    expect(deploymentUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png')
    expect(deploymentUrl('//example.com/logo.png')).toBe('//example.com/logo.png')
  })
  it('prefixes local assets/API once', () => {
    vi.stubEnv('BASE_URL', '/com.hermeswebui.studio/')
    expect(deploymentUrl('/logo.png')).toBe('/com.hermeswebui.studio/logo.png')
    expect(deploymentUrl('/api/auth/status')).toBe('/com.hermeswebui.studio/api/auth/status')
    expect(deploymentUrl('/com.hermeswebui.studio/logo.png')).toBe('/com.hermeswebui.studio/logo.png')
  })
  it('keeps Socket.IO namespace independent of the proxy transport path', () => {
    vi.stubGlobal('window', { location: { origin: 'https://nas.example' } })
    expect(socketEndpoint('https://nas.example/com.hermeswebui.studio', '/chat-run')).toEqual({
      url: 'https://nas.example/chat-run', path: '/com.hermeswebui.studio/socket.io',
    })
    expect(socketEndpoint('', '/chat-run')).toEqual({ url: '/chat-run', path: '/socket.io' })
    vi.unstubAllGlobals()
  })
})

it('keeps private runtime URLs separate from Socket.IO namespace', () => {
  expect(socketEndpoint('https://example.com/nested/app/', '/workflow')).toEqual({
    url: 'https://example.com/workflow', path: '/nested/app/socket.io',
  })
})
