import { describe, expect, it } from 'vitest'
import { normalizeEkkoRunData, normalizeSessionIdentity } from '../../packages/server/src/modules/studio/contracts/history-source'

describe('native Ekko source contract', () => {
  it.each(['ekko', 'ekko-agent', 'ekko_agent'])('normalizes legacy requests for %s before routing or queueing', agent => {
    for (const source of ['cli', 'api_server', 'coding_agent', 'builtin_agent']) {
      const data = { source, coding_agent_id: agent, agent_id: undefined as string | undefined }
      normalizeEkkoRunData(data)
      expect(data).toMatchObject({ source: 'builtin_agent', agent_id: 'ekko-agent', coding_agent_id: 'ekko-agent' })
      expect(normalizeSessionIdentity({ source, agent })).toEqual({ source: 'builtin_agent', agent: 'ekko-agent' })
    }
  })
  it('restores the native runtime from a stored legacy identity or a source-only request', () => {
    const restored = { source: 'coding_agent', agent_id: undefined as string | undefined }
    normalizeEkkoRunData(restored, { source: 'coding_agent', agent: 'ekko_agent' })
    expect(restored).toMatchObject({ source: 'builtin_agent', agent_id: 'ekko-agent' })
    const fresh = { source: 'builtin_agent', agent_id: undefined as string | undefined }
    normalizeEkkoRunData(fresh)
    expect(fresh.agent_id).toBe('ekko-agent')
  })
  it.each(['group_chat', 'workflow', 'global_agent'])('preserves the %s surface for fresh and restored Ekko runs', source => {
    for (const fields of [{ source }, { source: 'coding_agent', session_source: source }, { source: 'coding_agent' }]) {
      const data = { ...fields, agent_id: 'ekko-agent' }
      normalizeEkkoRunData(data, { source, agent: 'ekko_agent' })
      expect(data.source).toBe(source)
      expect(normalizeSessionIdentity({ source, agent: 'ekko_agent' }).source).toBe(source)
    }
  })
  it('keeps Hermes and external CLIs on their own runtimes and rejects mismatched native requests', () => {
    const hermes = { source: 'cli' }
    normalizeEkkoRunData(hermes, { source: 'cli', agent: 'hermes' })
    expect(hermes).toEqual({ source: 'cli' })
    const external = { source: 'coding_agent', coding_agent_id: 'codex' }
    normalizeEkkoRunData(external)
    expect(external).toEqual({ source: 'coding_agent', coding_agent_id: 'codex' })
    expect(() => normalizeEkkoRunData({ source: 'builtin_agent', agent_id: 'codex' })).toThrow('requires agent_id=ekko-agent')
  })
})
