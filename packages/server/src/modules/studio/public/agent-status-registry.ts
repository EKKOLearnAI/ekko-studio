export type AgentStatusId = 'hermes' | 'ekko-agent' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'

export type AgentStatusSource =
  | 'managed-runtime'
  | 'user-cli'
  | 'built-in'
  | 'not-installed'

export interface AgentInstallationStatus {
  path: string
  version: string
  source: 'managed-runtime' | 'user-cli'
  selected: boolean
  managedRuntimeVersion?: string
}

export interface AgentStatusRecord {
  id: AgentStatusId
  name: string
  provider: string
  kind: 'hermes' | 'built-in' | 'coding-agent'
  installed: boolean
  version: string
  source: AgentStatusSource
  path: string
  error: string
  installations: AgentInstallationStatus[]
  updatedAt: string
}

export interface AgentStatusSnapshot {
  revision: number
  updatedAt: string
  agents: AgentStatusRecord[]
}

export interface AgentAvailabilityRecord {
  id: AgentStatusId
  installed: boolean
  source: AgentStatusSource
}

export interface AgentAvailabilitySnapshot {
  revision: number
  updatedAt: string
  agents: AgentAvailabilityRecord[]
}

const AGENT_ORDER: AgentStatusId[] = ['hermes', 'ekko-agent', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor']

const DEFAULTS: Record<AgentStatusId, Omit<AgentStatusRecord, 'updatedAt'>> = {
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    provider: 'Nous Research',
    kind: 'hermes',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  'ekko-agent': {
    id: 'ekko-agent',
    name: 'Ekko',
    provider: 'Ekko Studio',
    kind: 'built-in',
    installed: true,
    version: '',
    source: 'built-in',
    path: '',
    error: '',
    installations: [],
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude',
    provider: 'Anthropic',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  pi: {
    id: 'pi',
    name: 'Pi',
    provider: 'Pi',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  dsh: {
    id: 'dsh', name: 'DeepSeek Harness', provider: 'DeepSeek', kind: 'coding-agent',
    installed: false, version: '', source: 'not-installed', path: '', error: '', installations: [],
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    provider: 'OpenCode',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  grok: {
    id: 'grok',
    name: 'Grok',
    provider: 'xAI',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    provider: 'Cursor',
    kind: 'coding-agent',
    installed: false,
    version: '',
    source: 'not-installed',
    path: '',
    error: '',
    installations: [],
  },
}

const records = new Map<AgentStatusId, AgentStatusRecord>()
let revision = 0
let updatedAt = new Date(0).toISOString()

for (const id of AGENT_ORDER) {
  records.set(id, { ...DEFAULTS[id], installations: [], updatedAt })
}

function cloneRecord(record: AgentStatusRecord): AgentStatusRecord {
  return {
    ...record,
    installations: record.installations.map(item => ({ ...item })),
  }
}

export function updateAgentStatus(
  id: AgentStatusId,
  status: Partial<Omit<AgentStatusRecord, 'id' | 'updatedAt'>>,
): AgentStatusRecord {
  const now = new Date().toISOString()
  const current = records.get(id) || { ...DEFAULTS[id], installations: [], updatedAt: now }
  const next: AgentStatusRecord = {
    ...current,
    ...status,
    id,
    installations: status.installations
      ? status.installations.map(item => ({ ...item }))
      : current.installations.map(item => ({ ...item })),
    updatedAt: now,
  }
  records.set(id, next)
  revision += 1
  updatedAt = now
  return cloneRecord(next)
}

export function updateAgentStatuses(
  statuses: Array<{ id: AgentStatusId } & Partial<Omit<AgentStatusRecord, 'id' | 'updatedAt'>>>,
): AgentStatusSnapshot {
  for (const status of statuses) {
    const { id, ...next } = status
    updateAgentStatus(id, next)
  }
  return getAgentStatusSnapshot()
}

export function getAgentStatusSnapshot(): AgentStatusSnapshot {
  return {
    revision,
    updatedAt,
    agents: AGENT_ORDER.map(id => cloneRecord(records.get(id)!)),
  }
}

export function getAgentAvailabilitySnapshot(): AgentAvailabilitySnapshot {
  return {
    revision,
    updatedAt,
    agents: AGENT_ORDER.map(id => {
      const record = records.get(id)!
      return {
        id,
        installed: record.installed,
        source: record.source,
      }
    }),
  }
}

export function isAgentAvailable(id: AgentStatusId): boolean {
  const status = records.get(id)
  if (!status?.installed || status.source === 'not-installed') return false
  return id !== 'hermes' || Boolean(status.path)
}

/**
 * Runtime services may only start when the in-memory inventory points at an
 * executable Hermes installation. A version by itself is not sufficient:
 * stale metadata must never make bootstrap fall back to spawning `hermes`
 * from PATH.
 */
export function isHermesAgentAvailable(): boolean {
  return isAgentAvailable('hermes')
}

export function resetAgentStatusRegistryForTests(): void {
  records.clear()
  revision = 0
  updatedAt = new Date(0).toISOString()
  for (const id of AGENT_ORDER) {
    records.set(id, { ...DEFAULTS[id], installations: [], updatedAt })
  }
}
