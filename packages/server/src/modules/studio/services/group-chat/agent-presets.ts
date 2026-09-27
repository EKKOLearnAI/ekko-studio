import type {
  GroupAgentPresetAgent,
  GroupAgentPresetDefinition,
} from '../../repositories/group-agent-preset-store'

export {
  createGroupAgentPreset,
  deleteGroupAgentPreset,
  getGroupAgentPreset,
  listGroupAgentPresets,
  updateGroupAgentPreset,
  type GroupAgentPresetRecord,
} from '../../repositories/group-agent-preset-store'

type CapabilityGroup = {
  provider: string
  models: string[]
  model_meta?: Record<string, { disabled?: boolean }>
}

const ALLOWED_FIELDS = new Set([
  'agent', 'agentMode', 'priorAgentMode', 'profile', 'provider', 'model', 'apiMode', 'reasoningEffort', 'agentPreset',
  'name', 'description', 'avatar',
])
const AGENTS = new Set<GroupAgentPresetAgent>(['hermes', 'ekko', 'codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])
const API_MODES = new Set(['chat_completions', 'codex_responses', 'anthropic_messages'])
const REASONING_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const AVATAR_MAX_LENGTH = 1_500_000
const GLOBAL_MODE_AGENTS = new Set<GroupAgentPresetAgent>(['codex', 'claude', 'pi', 'grok', 'opencode', 'dsh', 'cursor'])

function requiredText(value: unknown, field: string, max = 200): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw Object.assign(new Error(`${field} is required`), { status: 400 })
  if (normalized.length > max) throw Object.assign(new Error(`${field} is too long`), { status: 400 })
  return normalized
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value == null) return ''
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} must be a string`), { status: 400 })
  const normalized = value.trim()
  if (normalized.length > max) throw Object.assign(new Error(`${field} is too long`), { status: 400 })
  return normalized
}

function normalizeAvatar(value: unknown): string {
  const avatar = optionalText(value, 'avatar', AVATAR_MAX_LENGTH)
  if (!avatar) return ''
  let parsed: any
  try { parsed = JSON.parse(avatar) } catch {
    throw Object.assign(new Error('Invalid agent avatar'), { status: 400 })
  }
  if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim() && parsed.seed.length <= 200) {
    return JSON.stringify({ type: 'generated', seed: parsed.seed.trim() })
  }
  if (
    parsed?.type === 'image'
    && typeof parsed.dataUrl === 'string'
    && /^data:image\/(?:png|jpeg|webp);base64,/i.test(parsed.dataUrl)
    && parsed.dataUrl.length <= AVATAR_MAX_LENGTH
  ) {
    return JSON.stringify({ type: 'image', dataUrl: parsed.dataUrl })
  }
  throw Object.assign(new Error('Invalid agent avatar'), { status: 400 })
}

export function normalizeGroupAgentPresetInput(input: unknown): Omit<GroupAgentPresetDefinition, 'ownerUserId'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Preset body is required'), { status: 400 })
  }
  const record = input as Record<string, unknown>
  const unsupported = Object.keys(record).filter(key => !ALLOWED_FIELDS.has(key))
  if (unsupported.length) {
    throw Object.assign(new Error(`Preset contains unsupported or secret fields: ${unsupported.join(', ')}`), { status: 400 })
  }
  const agent = requiredText(record.agent || 'hermes', 'agent', 20) as GroupAgentPresetAgent
  if (!AGENTS.has(agent)) throw Object.assign(new Error('Invalid agent'), { status: 400 })
  const agentMode = agent === 'cursor' ? 'global' : record.agentMode === 'global' ? 'global' : 'scoped'
  if (record.priorAgentMode != null && record.priorAgentMode !== '' && record.priorAgentMode !== 'global' && record.priorAgentMode !== 'scoped') {
    throw Object.assign(new Error('Invalid priorAgentMode'), { status: 400 })
  }
  const priorAgentMode = record.priorAgentMode === 'global' || record.priorAgentMode === 'scoped' ? record.priorAgentMode : ''
  if (agentMode === 'global' && !GLOBAL_MODE_AGENTS.has(agent)) {
    throw Object.assign(new Error('Global mode is only available for Claude, Codex, Pi, Grok, OpenCode, DSH, and Cursor'), { status: 400 })
  }
  const apiMode = agent === 'hermes' || agentMode === 'global' ? '' : requiredText(record.apiMode, 'apiMode', 40)
  if (apiMode && !API_MODES.has(apiMode)) throw Object.assign(new Error('Invalid apiMode'), { status: 400 })
  const reasoningEffort = agentMode === 'global' ? '' : optionalText(record.reasoningEffort, 'reasoningEffort', 20)
  if (!REASONING_EFFORTS.has(reasoningEffort)) throw Object.assign(new Error('Invalid reasoningEffort'), { status: 400 })
  return {
    agent,
    agentMode,
    priorAgentMode,
    profile: requiredText(record.profile, 'profile'),
    provider: agentMode === 'global' ? '' : requiredText(record.provider, 'provider'),
    model: agentMode === 'global' ? '' : requiredText(record.model, 'model'),
    apiMode,
    reasoningEffort,
    agentPreset: optionalText(record.agentPreset, 'agentPreset', 200) || undefined,
    name: requiredText(record.name, 'name', 120),
    description: optionalText(record.description, 'description', 2_000),
    avatar: normalizeAvatar(record.avatar),
  }
}

export function validateGroupAgentPresetCapability(
  preset: Pick<GroupAgentPresetDefinition, 'agentMode' | 'provider' | 'model'>,
  groups: CapabilityGroup[],
): void {
  if (preset.agentMode === 'global') return
  const group = groups.find(item => item.provider === preset.provider)
  if (
    !group
    || !group.models.includes(preset.model)
    || group.model_meta?.[preset.model]?.disabled === true
  ) {
    throw Object.assign(
      new Error(`Preset provider/model is unavailable in profile: ${preset.provider}/${preset.model}`),
      { status: 409, code: 'GROUP_AGENT_PRESET_REFERENCE_UNAVAILABLE' },
    )
  }
}
