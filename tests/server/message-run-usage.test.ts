import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'

// Use the canonical test-runtime db dir that db/index.ts chooses under VITEST.
const TEST_DB_DIR = resolve(process.cwd(), 'packages/server/data/test-runtime')
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'hermes-web-ui.db')

function ensureSqliteAvailable() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(`node:sqlite requires Node >= 22.5, current: ${process.versions.node}`)
  }
}

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

describe('message run_id + usage persistence', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    // Singleton db handle in db/index.ts may still hold the file open; do not
    // attempt to delete it (EPERM on Windows). Each test uses a unique session
    // id, so leftover rows do not interfere across tests.
    vi.resetModules()
  })

  it('addMessage persists run_id and getSessionDetailPaginated maps it onto HermesMessageRow', async () => {
    ensureSqliteAvailable()
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    initAllHermesTables()

    const sid = `s1_${uniqueSuffix()}`
    sessionStore.createSession({
      id: sid, source: 'cli', model: 'gpt-5.5', title: 'session1',
      started_at: 100,
    })

    const id = sessionStore.addMessage({
      session_id: sid, role: 'assistant', content: 'assistant reply',
      timestamp: 110, finish_reason: 'stop', run_id: 'run_abc_123',
    })
    expect(id).toBeGreaterThan(0)

    const detail = sessionStore.getSessionDetailPaginated(sid, 0, 150)
    expect(detail).not.toBeNull()
    const msg = detail!.messages.find(m => m.role === 'assistant')
    expect(msg).toBeDefined()
    expect(msg!.content).toBe('assistant reply')
    expect(msg!.run_id).toBe('run_abc_123')
  })

  it('attachRunUsageToMessages injects runUsage onto assistant messages with a matching run_id', async () => {
    ensureSqliteAvailable()
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const usageStore = await import('../../packages/server/src/db/hermes/usage-store')
    initAllHermesTables()

    const sid = `s2_${uniqueSuffix()}`
    sessionStore.createSession({
      id: sid, source: 'cli', model: 'gpt-5.5', title: 'session2',
      started_at: 100,
    })

    // Provider-recorded usage for run_id=run_xyz
    usageStore.updateUsage(sid, {
      runId: 'run_xyz', source: 'hermes', apiCalls: 2,
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 30,
      cacheWriteTokens: 0, reasoningTokens: 12, isEstimated: false,
      model: 'glm-5.2', provider: 'custom', profile: 'default',
    })

    sessionStore.addMessage({
      session_id: sid, role: 'user', content: 'hello', timestamp: 110,
    })
    sessionStore.addMessage({
      session_id: sid, role: 'assistant', content: 'world', timestamp: 120,
      finish_reason: 'stop', run_id: 'run_xyz',
    })

    const detail = sessionStore.getSessionDetailPaginated(sid, 0, 150)
    const assistantMsg = detail!.messages.find(m => m.role === 'assistant')
    expect(assistantMsg?.run_id).toBe('run_xyz')
    expect(assistantMsg?.usage).toBeUndefined() // not yet injected

    const enriched = sessionStore.attachRunUsageToMessages(sid, detail!.messages)
    const enrichedAssistant = enriched.find(m => m.role === 'assistant')
    expect(enrichedAssistant?.usage).toEqual({
      input: 100, output: 50, cacheRead: 30, reasoning: 12, apiCalls: 2,
    })
    const userMsg = enriched.find(m => m.role === 'user')
    expect(userMsg?.usage).toBeUndefined() // never inject onto non-assistant
  })
})
