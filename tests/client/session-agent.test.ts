import { describe, expect, it } from 'vitest'
import { historySessionSource, sessionAgentFields, isBuiltinEkkoSession, isExternalCodingAgentSession } from '@/utils/hermes/session-agent'
import type { SessionSummary } from '@/api/studio/sessions'
import { EKKO_SESSION_COMMAND_DEFINITIONS, isKnownEkkoSessionCommand, isKnownBridgeSessionCommand } from '@/utils/hermes/bridge-session-commands'

describe('built-in Ekko session classification', () => {
  it.each(['ekko', 'ekko_agent', 'ekko-agent'])('recognizes %s before the legacy source flag', agent => {
    expect(isBuiltinEkkoSession({ agent, source: 'coding_agent' })).toBe(true)
    expect(isExternalCodingAgentSession({ agent, source: 'coding_agent' })).toBe(false)
    expect(isExternalCodingAgentSession({ codingAgentId: agent, source: 'coding_agent' })).toBe(false)
    for (const source of ['coding_agent', 'cli', 'api_server']) {
      expect(historySessionSource({ agent, source })).toBe('builtin_agent')
    }
    expect(historySessionSource({ agent, source: 'group_chat' })).toBe('group_chat')
    expect(historySessionSource({ agent, source: 'workflow' })).toBe('workflow')
    const session = { agent, source: 'coding_agent', agent_mode: 'global', agent_session_id: 'runtime', agent_native_session_id: 'native' } as SessionSummary
    expect(sessionAgentFields(session)).toMatchObject({ codingAgentId: 'ekko-agent', codingAgentMode: 'scoped', agentSessionId: 'runtime', agentNativeSessionId: 'native' })
    expect(session.source).toBe('coding_agent')
  })
  it('keeps Hermes and external runtimes distinct', () => {
    expect(isExternalCodingAgentSession({ agent: 'hermes', source: 'cli' })).toBe(false)
    for (const agent of ['claude', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity']) {
      expect(isExternalCodingAgentSession({ agent })).toBe(true)
    }
    expect(isExternalCodingAgentSession({ codingAgentId: 'future-cli' })).toBe(true)
    expect(historySessionSource({ codingAgentId: 'future-cli', source: 'coding_agent' })).toBe('coding_agent')
    expect(historySessionSource({ source: 'cli', agent: 'hermes' })).toBe('cli')
  })
  it('keeps Ekko commands small and Hermes commands intact', () => {
    expect(EKKO_SESSION_COMMAND_DEFINITIONS.map(command => command.name)).toEqual(['context', 'compact', 'usage', 'status'])
    expect(isKnownEkkoSessionCommand('/compact')).toBe(true)
    expect(isKnownEkkoSessionCommand('/compress')).toBe(true)
    for (const command of ['yolo', 'goal', 'plan', 'reload-mcp']) {
      expect(isKnownBridgeSessionCommand(`/${command}`)).toBe(true)
      expect(isKnownEkkoSessionCommand(`/${command}`)).toBe(false)
    }
  })
})
