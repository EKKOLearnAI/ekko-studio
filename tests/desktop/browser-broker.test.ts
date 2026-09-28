import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../../packages/desktop/src/main/browser/browser-broker'
import type { BrowserManager } from '../../packages/desktop/src/main/browser/browser-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Desktop Browser Broker', () => {
  it.each(['observed', 'popup', 'unavailable'] as const)('preserves single-action %s evidence over HTTP', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-interact-'))
    roots.push(root)
    const tab = { id: 'tab-1', title: 'Example', url: 'https://example.com/?token=private', agentControl: 'idle' }
    const snapshot = { tabId: mode === 'popup' ? 'popup' : tab.id, snapshotId: 'fresh', nodes: [] }
    const evidence = mode === 'unavailable'
      ? { snapshotError: 'Follow-up snapshot unavailable', observation: { status: 'unavailable', hint: 'Read a fresh snapshot' } }
      : { snapshot, observation: { status: 'observed', tabId: tab.id, changed: true,
        ...(mode === 'popup' ? { openedTabs: [{ id: 'popup', title: 'Destination', url: 'https://example.com/next' }] } : {}) } }
    const manager = {
      state: () => ({ tabs: [tab] }),
      interact: async () => ({ ...tab, ...evidence, internalOnly: '/private/profile' }),
      setAgentControl: () => {}, revokeAgentControl: () => {}, cancelAgentOperation: () => {},
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()
    try {
      const registration = await fetch(`${descriptor.endpoint}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: '{}',
      })
      const client = await registration.json() as { client_id: string; session_token: string }
      const response = await fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'interact', params: { tab_id: tab.id, action: { action: 'press', key: 'Tab' } } }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.result).toMatchObject({ id: tab.id, ...evidence })
      expect(body.result).not.toHaveProperty('internalOnly')
      expect(JSON.stringify(body)).not.toContain('private')
    } finally {
      await broker.stop()
    }
  })

  it('authenticates loopback MCP clients and enforces per-tab leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    const manager = {
      state: () => ({ tabs, activeTabId: 'tab-1', maxTabs: 12, profiles: [{ sessionPath: '/private/profile' }], downloads: [{ savePath: '/private/download' }] }),
      snapshot: async (tabId: string) => ({ tabId, snapshotId: 'snapshot-1' }),
      setAgentControl: (tabId: string, control: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = control },
      revokeAgentControl: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
      cancelAgentOperation: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    try {
      const unauthorized = await fetch(descriptor.endpoint, { method: 'POST', body: '{}' })
      expect(unauthorized.status).toBe(401)

      const browserOrigin = await fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${descriptor.token}`, Origin: 'https://evil.example', 'X-Hermes-Browser-Client': 'client-a' },
        body: JSON.stringify({ method: 'snapshot', params: { tab_id: 'tab-1' } }),
      })
      expect(browserOrigin.status).toBe(403)

      const register = async (clientPid?: number) => {
        const response = await fetch(`${descriptor.endpoint}/session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(clientPid === undefined ? {} : { client_pid: clientPid }),
        })
        return await response.json() as { client_id: string; session_token: string }
      }
      const clientA = await register(process.pid)
      const clientB = await register(process.pid)
      const listResponse = await fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientA.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': clientA.client_id },
        body: JSON.stringify({ method: 'tabs.list', params: {} }),
      })
      const listBody = await listResponse.json()
      expect(listBody.result.tabs).toHaveLength(1)
      expect(JSON.stringify(listBody)).not.toContain('/private/')
      const invoke = (client: { client_id: string; session_token: string }) => fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'snapshot', params: { tab_id: 'tab-1' } }),
      })
      expect((await invoke(clientA)).status).toBe(200)
      expect((await invoke(clientB)).status).toBe(409)
      broker.revokeTab('tab-1')
      expect((await invoke(clientB)).status).toBe(200)

      const stored = JSON.parse(await readFile(join(root, 'broker.json'), 'utf8'))
      expect(stored.endpoint).toBe(descriptor.endpoint)
      expect(stored.token).toBe(descriptor.token)
      if (process.platform !== 'win32') expect((await stat(join(root, 'broker.json'))).mode & 0o077).toBe(0)
    } finally {
      await broker.stop()
    }
  })

  it('validates and forwards bounded text reads for snapshot refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-read-text-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    const manager = {
      state: () => ({ tabs }),
      readText: async (tabId: string, options: Record<string, unknown>) => ({
        tabId,
        ...options,
        text: 'full text',
        totalLength: 9,
        returnedLength: 9,
        hasMore: false,
      }),
      setAgentControl: (tabId: string, control: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = control },
      revokeAgentControl: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
      cancelAgentOperation: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    try {
      const registration = await fetch(`${descriptor.endpoint}/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const client = await registration.json() as { client_id: string; session_token: string }
      const invoke = (limit: number) => fetch(descriptor.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client.session_token}`,
          'Content-Type': 'application/json',
          'X-Hermes-Browser-Client': client.client_id,
        },
        body: JSON.stringify({
          method: 'text.read',
          params: {
            tab_id: 'tab-1',
            snapshot_id: 'snapshot-1',
            ref: '@e1',
            mode: 'textContent',
            offset: 10,
            limit,
          },
        }),
      })

      const response = await invoke(2_000)
      expect(response.status).toBe(200)
      expect((await response.json()).result).toMatchObject({
        tabId: 'tab-1',
        snapshotId: 'snapshot-1',
        ref: '@e1',
        mode: 'textContent',
        offset: 10,
        limit: 2_000,
      })
      const oversized = await invoke(20_001)
      expect(oversized.status).toBe(400)
      expect((await oversized.json()).error).toContain('limit must be an integer between 1 and 20000')
    } finally {
      await broker.stop()
    }
  })

  it('reclaims a tab lease when its registered MCP process has exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-stale-client-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    const manager = {
      state: () => ({ tabs }),
      snapshot: async (tabId: string) => ({ tabId, snapshotId: 'snapshot-1' }),
      setAgentControl: (tabId: string, control: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = control },
      revokeAgentControl: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
      cancelAgentOperation: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    try {
      const register = async (clientPid: number) => {
        const response = await fetch(`${descriptor.endpoint}/session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_pid: clientPid }),
        })
        return await response.json() as { client_id: string; session_token: string }
      }
      const staleClient = await register(2_147_483_647)
      const activeClient = await register(process.pid)
      const invoke = (client: { client_id: string; session_token: string }) => fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'snapshot', params: { tab_id: 'tab-1' } }),
      })

      expect((await invoke(staleClient)).status).toBe(200)
      expect((await invoke(activeClient)).status).toBe(200)
    } finally {
      await broker.stop()
    }
  })

  it('cancels queued work and does not restore control after user takeover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-cancel-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    let releaseSnapshot!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const manager = {
      state: () => ({ tabs }),
      snapshot: async (tabId: string) => { markStarted(); await snapshotGate; return { tabId, snapshotId: 'snapshot-1' } },
      setAgentControl: (tabId: string, control: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = control },
      revokeAgentControl: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
      cancelAgentOperation: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    try {
      const registration = await fetch(`${descriptor.endpoint}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: '{}',
      })
      const client = await registration.json() as { client_id: string; session_token: string }
      const invoke = () => fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'snapshot', params: { tab_id: 'tab-1' } }),
      })
      const running = invoke()
      await started
      const queued = invoke()
      await new Promise(resolve => setTimeout(resolve, 20))
      broker.revokeTab('tab-1')
      releaseSnapshot()

      expect((await running).status).toBe(409)
      expect((await queued).status).toBe(409)
      expect(tabs[0].agentControl).toBe('idle')
    } finally {
      releaseSnapshot()
      await broker.stop()
    }
  })

  it('runs different tabs concurrently while enforcing the global limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-capacity-'))
    roots.push(root)
    const tabs = Array.from({ length: 5 }, (_, index) => ({ id: `tab-${index + 1}`, agentControl: 'idle' }))
    let active = 0
    let maximum = 0
    let releaseSnapshots!: () => void
    let capacityReached!: () => void
    const gate = new Promise<void>(resolve => { releaseSnapshots = resolve })
    const reached = new Promise<void>(resolve => { capacityReached = resolve })
    const manager = {
      state: () => ({ tabs }),
      snapshot: async (tabId: string) => {
        active += 1
        maximum = Math.max(maximum, active)
        if (active === 4) capacityReached()
        await gate
        active -= 1
        return { tabId, snapshotId: `snapshot-${tabId}` }
      },
      setAgentControl: (tabId: string, control: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = control },
      revokeAgentControl: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
      cancelAgentOperation: (tabId: string) => { const tab = tabs.find(item => item.id === tabId); if (tab) tab.agentControl = 'idle' },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    try {
      const registration = await fetch(`${descriptor.endpoint}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: '{}',
      })
      const client = await registration.json() as { client_id: string; session_token: string }
      const calls = tabs.map(tab => fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'snapshot', params: { tab_id: tab.id } }),
      }))
      await reached
      expect(maximum).toBe(4)
      releaseSnapshots()
      expect((await Promise.all(calls)).every(response => response.status === 200)).toBe(true)
      expect(maximum).toBe(4)
    } finally {
      releaseSnapshots()
      await broker.stop()
    }
  })

  it.each(['none', 'takeover', 'shutdown'])('holds the tab queue for a whole batch and stops on cancellation: %s', async cancellation => {
    const takeover = cancellation === 'takeover'
    const shutdown = cancellation === 'shutdown'
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-batch-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    const events: string[] = []
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const manager = {
      state: () => ({ tabs }),
      setAgentControl: () => {}, revokeAgentControl: () => {}, cancelAgentOperation: () => {},
      snapshot: async () => { events.push('snapshot'); return { snapshotId: 'later' } },
      interactBatch: async (tabId: string, actions: unknown, snapshotId: unknown, assertControl: () => void) => {
        expect(tabId).toBe('tab-1')
        expect(snapshotId).toBe('initial')
        expect(actions).toEqual([{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Enter' }])
        events.push('first')
        markStarted()
        await gate
        try {
          assertControl()
          events.push('second')
          return { completed: 2, total: 2 }
        } catch (error) {
          return { completed: 1, total: 2, results: [{ index: 1, status: 'failed', error: (error as Error).message }] }
        }
      },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()
    try {
      const registration = await fetch(`${descriptor.endpoint}/session`, {
        method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: '{}',
      })
      const client = await registration.json() as { client_id: string; session_token: string }
      const invoke = (method: string, params: Record<string, unknown>) => fetch(descriptor.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method, params }),
      }).catch(() => null)
      const running = invoke('interact.batch', { tab_id: 'tab-1', snapshot_id: 'initial', actions: [{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Enter' }] })
      await started
      const queued = invoke('snapshot', { tab_id: 'tab-1' })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(events).toEqual(['first'])
      if (takeover) broker.revokeTab('tab-1')
      if (shutdown) await broker.stop(25)
      release()
      const response = await running
      if (shutdown) {
        await queued
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(events).not.toContain('second')
        return
      }
      expect(response?.status).toBe(200)
      expect((await response!.json()).result).toMatchObject({ completed: takeover ? 1 : 2, total: 2 })
      expect((await queued)?.status).toBe(takeover ? 409 : 200)
      expect(events).toEqual(takeover ? ['first'] : ['first', 'second', 'snapshot'])
    } finally {
      release()
      await broker.stop()
    }
  })

  it('bounds shutdown and cancels an active browser operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-broker-stop-'))
    roots.push(root)
    const tabs = [{ id: 'tab-1', agentControl: 'idle' }]
    let markStarted!: () => void
    let releaseSnapshot!: () => void
    let cancelled = 0
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const gate = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const manager = {
      state: () => ({ tabs }),
      snapshot: async () => {
        markStarted()
        await gate
        return { tabId: 'tab-1', snapshotId: 'snapshot-1' }
      },
      setAgentControl: () => {},
      revokeAgentControl: () => {},
      cancelAgentOperation: () => { cancelled += 1 },
    } as unknown as BrowserManager
    const broker = new BrowserBroker(manager, root)
    const descriptor = await broker.start()

    const registration = await fetch(`${descriptor.endpoint}/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const client = await registration.json() as { client_id: string; session_token: string }
    const running = fetch(descriptor.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.session_token}`,
        'Content-Type': 'application/json',
        'X-Hermes-Browser-Client': client.client_id,
      },
      body: JSON.stringify({ method: 'snapshot', params: { tab_id: 'tab-1' } }),
    }).catch(() => null)

    await started
    await broker.stop(25)
    expect(cancelled).toBe(1)
    releaseSnapshot()
    await running
  })
})
