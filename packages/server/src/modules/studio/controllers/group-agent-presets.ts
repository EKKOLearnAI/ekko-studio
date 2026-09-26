import {
  createGroupAgentPreset,
  deleteGroupAgentPreset,
  getGroupAgentPreset,
  listGroupAgentPresets,
  updateGroupAgentPreset,
  type GroupAgentPresetRecord,
} from '../services/group-chat/agent-presets'
import { getGroupAvailableModelGroups } from '../public/group-chat-agent-runtime'
import {
  normalizeGroupAgentPresetInput,
  validateGroupAgentPresetCapability,
} from '../services/group-chat/agent-presets'
import { assertAgentAvailable } from '../services/agent-availability'

function authenticatedUser(ctx: any): { id: number; role: string; profiles?: string[] } | null {
  const user = ctx.state?.user
  if (!user || !Number.isInteger(user.id) || user.id <= 0) {
    ctx.status = 401
    ctx.body = { error: 'Authentication required' }
    return null
  }
  return user
}

function assertProfileAccess(user: { role: string; profiles?: string[] }, profile: string): void {
  if (user.role === 'super_admin') return
  if (!Array.isArray(user.profiles) || !user.profiles.includes(profile)) {
    throw Object.assign(new Error(`Profile "${profile}" is not available for this user`), { status: 403 })
  }
}

export async function resolveGroupAgentPresetForApplication(user: any, presetId: string) {
  if (!user || !Number.isInteger(user.id) || user.id <= 0) {
    throw Object.assign(new Error('Authentication required to apply an Agent preset'), { status: 401 })
  }
  const preset = getGroupAgentPreset(presetId, user.id)
  if (!preset) throw Object.assign(new Error('Agent preset not found'), { status: 404 })
  assertProfileAccess(user, preset.profile)
  validateGroupAgentPresetCapability(preset, await getGroupAvailableModelGroups(preset.profile))
  assertAgentAvailable(preset.agent)
  return {
    agent: preset.agent,
    agentMode: preset.agentMode,
    priorAgentMode: preset.priorAgentMode,
    profile: preset.profile,
    provider: preset.provider,
    model: preset.model,
    apiMode: preset.apiMode,
    reasoningEffort: preset.reasoningEffort,
    agentPreset: preset.agentPreset,
    name: preset.name,
    description: preset.description,
    avatar: preset.avatar,
  }
}

async function validateDefinition(user: { role: string; profiles?: string[] }, input: unknown) {
  const definition = normalizeGroupAgentPresetInput(input)
  assertProfileAccess(user, definition.profile)
  validateGroupAgentPresetCapability(definition, await getGroupAvailableModelGroups(definition.profile))
  assertAgentAvailable(definition.agent)
  return definition
}

async function serializeAvailability(preset: GroupAgentPresetRecord) {
  try {
    validateGroupAgentPresetCapability(preset, await getGroupAvailableModelGroups(preset.profile))
    assertAgentAvailable(preset.agent)
    return { ...preset, available: true, validationError: '' }
  } catch (error: any) {
    return { ...preset, available: false, validationError: error?.message || 'Preset references are unavailable' }
  }
}

function respondError(ctx: any, error: any): void {
  ctx.status = Number(error?.status || (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500))
  ctx.body = { code: error?.code, error: error?.message || 'Failed to save Agent preset' }
}

export async function list(ctx: any): Promise<void> {
  const user = authenticatedUser(ctx)
  if (!user) return
  const requestedProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  if (requestedProfile) {
    try { assertProfileAccess(user, requestedProfile) } catch (error) { respondError(ctx, error); return }
  }
  const presets = listGroupAgentPresets(user.id)
    .filter(preset => user.role === 'super_admin' || user.profiles?.includes(preset.profile))
    .filter(preset => !requestedProfile || preset.profile === requestedProfile)
  ctx.body = { presets: await Promise.all(presets.map(serializeAvailability)) }
}

export async function create(ctx: any): Promise<void> {
  const user = authenticatedUser(ctx)
  if (!user) return
  try {
    const definition = await validateDefinition(user, ctx.request.body)
    ctx.status = 201
    ctx.body = { preset: { ...createGroupAgentPreset({ ...definition, ownerUserId: user.id }), available: true, validationError: '' } }
  } catch (error) {
    respondError(ctx, error)
  }
}

export async function update(ctx: any): Promise<void> {
  const user = authenticatedUser(ctx)
  if (!user) return
  if (!getGroupAgentPreset(ctx.params.presetId, user.id)) {
    ctx.status = 404
    ctx.body = { error: 'Agent preset not found' }
    return
  }
  try {
    const definition = await validateDefinition(user, ctx.request.body)
    const preset = updateGroupAgentPreset(ctx.params.presetId, user.id, { ...definition, ownerUserId: user.id })
    ctx.body = { preset: { ...preset, available: true, validationError: '' } }
  } catch (error) {
    respondError(ctx, error)
  }
}

export async function remove(ctx: any): Promise<void> {
  const user = authenticatedUser(ctx)
  if (!user) return
  if (!deleteGroupAgentPreset(ctx.params.presetId, user.id)) {
    ctx.status = 404
    ctx.body = { error: 'Agent preset not found' }
    return
  }
  ctx.body = { success: true }
}
