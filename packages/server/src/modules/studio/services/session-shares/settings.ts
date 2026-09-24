import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { SessionShareError, type SessionShareAction } from '../../contracts/session-shares'
import { getHermesModelContextLength, getSessionAvailableModelGroups } from '../../public/session-agent-runtime'
import { upsertModelContextRecord } from '../../public/provider-context'
import { getSession } from '../../repositories/session-store'
import { authorizeSessionShare, type SessionShareAccess } from './access'
import { sessionShareService } from './service'

function contextSession(access: SessionShareAccess, action: 'read' | 'switchModel') {
  const share = authorizeSessionShare(access, action)
  const session = getSession(share.session_id)
  if (!session) throw new SessionShareError('share_session_unavailable', 404)
  const agent = String(session.agent || 'hermes').toLowerCase()
  if (agent !== 'ekko-agent' && (session.source === 'coding_agent' || !['hermes', ''].includes(agent))) {
    throw new SessionShareError('share_context_limit_unsupported', 400)
  }
  return { session, profile: share.profile }
}

export function sessionShareContextLength(access: SessionShareAccess) {
  const { session, profile } = contextSession(access, 'read')
  return { context_length: getHermesModelContextLength({ profile, provider: session.provider, model: session.model }) }
}

export function setSessionShareContextLength(access: SessionShareAccess, input: any) {
  const { session, profile } = contextSession(access, 'switchModel')
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['provider', 'model', 'context_limit'].includes(key))
    || !Number.isInteger(input.context_limit) || input.context_limit < 1000 || input.context_limit > 10_000_000) {
    throw new SessionShareError('share_invalid_request', 400)
  }
  // The recipient can edit only the model currently selected on the shared session.
  // Requiring its identity also rejects a save from an editor opened before a model switch.
  if (!session.provider || !session.model || input.provider !== session.provider || input.model !== session.model) {
    throw new SessionShareError('share_model_unavailable', 400)
  }
  const result = upsertModelContextRecord(profile, session.provider, session.model, input.context_limit)
  if (!result.available) throw new SessionShareError('share_context_limit_unavailable', 503)
  return { context_length: input.context_limit }
}

/** Return selectable labels/IDs only; provider credentials never leave Studio. */
export async function sessionShareModels(access: SessionShareAccess) {
  authorizeSessionShare(access, 'switchModel')
  const groups = await getSessionAvailableModelGroups(access.share.profile)
  authorizeSessionShare(access, 'switchModel')
  return groups.map(group => ({
    provider: String(group.provider || ''), label: String(group.label || group.provider || ''),
    models: (Array.isArray(group.models) ? group.models : []).filter((model: unknown) =>
      typeof model === 'string' && group.model_meta?.[model]?.disabled !== true),
    api_mode: ['chat_completions', 'codex_responses', 'anthropic_messages'].includes(group.api_mode) ? group.api_mode : undefined,
  })).filter(group => group.models.length)
}

export async function prepareSessionShareSetting(access: SessionShareAccess, action: SessionShareAction, body: any) {
  const fields = action === 'switchModel' ? ['model', 'provider', 'apiMode', 'api_mode']
    : action === 'reasoningEffort' ? ['reasoningEffort', 'reasoning_effort'] : ['workspace']
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
    throw new SessionShareError('share_invalid_request', 400)
  }
  if (action === 'switchWorkspace') {
    body.workspace = sessionShareService.authorizeWorkspaceSwitch(access.token, access.actor, body.workspace)
  } else if (action === 'switchModel') {
    const groups = await sessionShareModels(access)
    const group = groups.find(item => item.provider === body.provider && item.models.includes(body.model))
    if (!group) throw new SessionShareError('share_model_unavailable', 400)
    // Use server-owned provider configuration, never a recipient's API mode override.
    delete body.api_mode
    body.apiMode = group.api_mode
  }
  authorizeSessionShare(access, action)
}

export async function sessionShareWorkspaces(access: SessionShareAccess, path: unknown) {
  const share = authorizeSessionShare(access, 'switchWorkspace')
  const folder = (fullPath: string) => ({ name: basename(fullPath) || fullPath, path: fullPath, fullPath, readonly: true })
  const roots = [share.workspace_root, ...(share.permissions.outsideWorkspace ? share.extra_paths.map(root => root.path) : [])]
    .filter(root => {
      try { sessionShareService.authorizeWorkspaceSwitch(access.token, access.actor, root); return true } catch { return false }
    }).map(folder)
  if (!path) return { base: share.workspace_root, current: getSession(share.session_id)?.workspace || '', roots, folders: [] }
  const directory = sessionShareService.authorizeWorkspaceSwitch(access.token, access.actor, path)
  const entries = await readdir(directory, { withFileTypes: true })
  const folders = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).flatMap(entry => {
    try { return [folder(sessionShareService.authorizeWorkspaceSwitch(access.token, access.actor, join(directory, entry.name)))] } catch { return [] }
  })
  authorizeSessionShare(access, 'switchWorkspace')
  return { base: share.workspace_root, current: directory, folders }
}
