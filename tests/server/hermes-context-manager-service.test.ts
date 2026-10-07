import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), settings: vi.fn(), ready: vi.fn() }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/client', () => ({
  AgentBridgeClient: class { request = mocks.request },
}))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: () => ({ endpoint: 'ipc://test', ensureReady: mocks.ready }),
}))

import {
  compactBiliConversation,
  configureHermesContextManager,
  resolveSessionContextOwner,
} from '../../packages/server/src/modules/hermes/public/context-manager'

const owner = {
  manager: 'bili' as const, owner: 'bili' as const, selectedManager: 'native' as const,
  independentPlugin: true, conversationId: 's', proxyUrl: 'http://localhost:2345', allowNativeFallback: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  configureHermesContextManager({ loadSettings: mocks.settings })
  mocks.settings.mockResolvedValue({ hermes: { manager: 'native' }, ekko: { manager: 'bili' }, proxyUrl: owner.proxyUrl, allowNativeFallback: true })
  mocks.request.mockResolvedValue({ ok: true, session_id: 's', context_manager: owner })
})

describe('Hermes context manager public service', () => {
  it('loads bootstrap-injected settings and observes an independent owner', async () => {
    expect(await resolveSessionContextOwner('s', 'p', 'hermes')).toEqual(owner)
    expect(mocks.settings).toHaveBeenCalledWith('p')
    expect(mocks.request).toHaveBeenCalledWith({ action: 'context_manager_status', session_id: 's', profile: 'p',
      context_manager: { manager: 'native', proxyUrl: owner.proxyUrl, allowNativeFallback: true, conversationId: 's' } })
  })

  it('passes a managed profile CA binding only for explicit bili ownership', async () => {
    const caBundlePath = '/profile/data/billion-context/ca/combined-ca.pem'
    mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' },
      proxyUrl: owner.proxyUrl, allowNativeFallback: true, caBundlePath })
    mocks.request.mockResolvedValue({ context_manager: { ...owner, selectedManager: 'bili', independentPlugin: false, caBundlePath } })
    await resolveSessionContextOwner('s', 'p', 'hermes')
    expect(mocks.request.mock.calls[0][0].context_manager.caBundlePath).toBe(caBundlePath)
    mocks.settings.mockResolvedValue({ hermes: { manager: 'native' }, ekko: { manager: 'native' },
      proxyUrl: owner.proxyUrl, allowNativeFallback: true, caBundlePath })
    mocks.request.mockResolvedValue({ context_manager: owner })
    await resolveSessionContextOwner('s', 'p', 'hermes')
    expect(mocks.request.mock.calls[1][0].context_manager).not.toHaveProperty('caBundlePath')
  })

  it('rejects a foreign conversation identity', async () => {
    mocks.request.mockResolvedValue({ context_manager: { ...owner, conversationId: 'other' } })
    await expect(resolveSessionContextOwner('s', 'p', 'hermes')).rejects.toThrow(/identity/)
  })

  it('rejects owner disagreement instead of silently choosing native', async () => {
    mocks.request.mockResolvedValue({ context_manager: { ...owner, owner: 'native' } })
    await expect(resolveSessionContextOwner('s', 'p', 'hermes')).rejects.toThrow(/ownership/)
  })

  it('rejects a worker returning a different bili proxy or profile CA binding', async () => {
    const caBundlePath = '/profile/data/billion-context/ca/combined-ca.pem'
    mocks.settings.mockResolvedValue({ hermes: { manager: 'bili' }, ekko: { manager: 'native' },
      proxyUrl: owner.proxyUrl, allowNativeFallback: true, caBundlePath })
    for (const binding of [{ proxyUrl: 'http://foreign:2345', caBundlePath },
      { proxyUrl: owner.proxyUrl, caBundlePath: '/global/combined-ca.pem' },
      { proxyUrl: owner.proxyUrl }]) {
      mocks.request.mockResolvedValue({ context_manager: { ...owner, selectedManager: 'bili', independentPlugin: false, ...binding } })
      await expect(resolveSessionContextOwner('s', 'p', 'hermes')).rejects.toThrow(/ownership/)
    }
  })

  it('does not mistake a host rewrite notification for a compression tool', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      ok: true, protocolVersion: 1, compactEndpoint: '/__bili/plugin/compact', capabilities: { compact: true },
      toolNames: ['compress'], tools: { anthropic: [{ name: 'compress', input_schema: { required: ['content'] } }] },
    }) })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(compactBiliConversation('s', 'p', owner, 'ekko')).rejects.toThrow(/public session compact tool/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})