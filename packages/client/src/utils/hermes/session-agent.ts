import type { SessionSummary } from '@/api/studio/sessions'
import type { Session } from '@/stores/hermes/chat'

type SessionAgentIdentity = { source?: string; agent?: string; codingAgentId?: string }

export function isBuiltinEkkoSession(session?: SessionAgentIdentity | null): boolean {
  return session?.source === 'builtin_agent' || ['ekko', 'ekko-agent', 'ekko_agent'].includes((session?.codingAgentId || session?.agent || '').trim().toLowerCase())
}

export function historySessionSource(session?: SessionAgentIdentity | null): string {
  const source = session?.source || ''
  return ['cli', 'api_server', 'coding_agent'].includes(source) && isBuiltinEkkoSession(session)
    ? 'builtin_agent'
    : source
}

// Retain legacy local runtime fields when opening old/imported sessions.
// New native runs use builtin_agent and agent_id on the wire.
export function sessionAgentFields(summary: SessionSummary): Pick<Session, 'agent' | 'agentSessionId' | 'agentNativeSessionId' | 'codingAgentId' | 'codingAgentMode'> {
  const builtin = isBuiltinEkkoSession(summary)
  const ids: Record<string, Session['codingAgentId']> = {
    claude: 'claude-code', 'claude-code': 'claude-code', claude_code: 'claude-code',
    codex: 'codex', pi: 'pi', grok: 'grok', cursor: 'cursor',
    qwen: 'qwen',
    kimi: 'kimi',
    codebuddy: 'codebuddy',
    qoder: 'qoder',
    copilot: 'copilot',
    zcode: 'zcode',
    antigravity: 'antigravity', dsh: 'dsh', opencode: 'opencode',
  }
  const providerAgent = builtin || isExternalCodingAgentSession(summary)
  return {
    agent: summary.agent || undefined,
    agentSessionId: summary.agent_session_id || undefined,
    agentNativeSessionId: summary.agent_native_session_id || undefined,
    codingAgentId: builtin ? 'ekko-agent' : ids[summary.agent || ''],
    codingAgentMode: builtin ? 'scoped' : providerAgent
      ? (summary.agent_mode === 'global' || summary.agent_mode === 'scoped'
          ? summary.agent_mode : summary.provider === 'global' ? 'global' : 'scoped')
      : undefined,
  }
}

export function isExternalCodingAgentSession(session?: SessionAgentIdentity | null): boolean {
  if (!session || isBuiltinEkkoSession(session)) return false
  return session.source === 'coding_agent' || Boolean(session.codingAgentId)
    || ['claude', 'claude-code', 'claude_code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode'].includes(session.agent || '')
}
