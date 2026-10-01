import { existsSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { updateConfigYamlForProfile, saveEnvValueForProfile, PROVIDER_ENV_MAP } from '../../studio/public/profile-config'
import { getCompatibleCustomProviders, normalizeCustomProviderEntry } from '../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../studio/contracts/providers'
import { logger } from '../../studio/public/logging'
import {
  getProviderEditorDetail,
  ProviderEditorError,
  testProviderEditorDraft,
  updateProviderContextLengths,
  updateProviderEditorDetail,
  type ProviderEditorPatch,
} from '../services/providers/provider-editor'
import { refreshProviderModels, restoreProviderModels } from '../services/providers/provider-model-refresh'
import { appendProviderAuditEvent } from '../../studio/public/provider-audit'
import { invalidateProviderRuntime } from '../../studio/public/provider-runtime'
import { OPENCODE_FREE_PROVIDER, OPENCODE_FREE_BASE_URL, isOpenCodeFreeModel } from '../../studio/contracts/opencode-free'
import { preservedModelKeys } from '../services/models/model-section'

const OPTIONAL_API_KEY_PROVIDERS = new Set(['cliproxyapi', 'xai-oauth', 'openai-codex', 'claude-oauth', 'minimax-oauth', OPENCODE_FREE_PROVIDER])
const DIRECT_CONFIG_PROVIDERS = new Set(['xai-oauth', 'openai-codex', 'claude-oauth', 'minimax-oauth', OPENCODE_FREE_PROVIDER])
type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function expectedRevision(ctx: any): string {
  const header = String(ctx.get?.('if-match') || ctx.headers?.['if-match'] || '').trim()
  const bodyRevision = String(ctx.request?.body?.revision || '').trim()
  return header || bodyRevision
}

function setRevisionHeader(ctx: any, revision: string): void {
  if (revision) ctx.set?.('ETag', `"${revision}"`)
}

function actorForAudit(ctx: any) {
  const user = ctx.state?.user
  return user ? { id: user.id, username: user.username, role: user.role } : undefined
}

function appendAuditSafely(input: Parameters<typeof appendProviderAuditEvent>[0]): void {
  try { appendProviderAuditEvent(input) } catch (error) { logger.warn(error, 'Failed to append provider audit event') }
}

function respondEditorError(ctx: any, error: unknown, providerId: string, action: string): void {
  const err = error as any
  const status = err instanceof ProviderEditorError ? err.status : 500
  const code = err instanceof ProviderEditorError ? err.code : 'PROVIDER_EDITOR_FAILED'
  ctx.status = status
  ctx.body = {
    error: err?.message || 'Provider editor operation failed',
    code,
    ...(err instanceof ProviderEditorError && err.current ? { current: err.current } : {}),
  }
  appendAuditSafely({
    actor: actorForAudit(ctx),
    profile: requestedProfile(ctx),
    providerId,
    providerLabel: err instanceof ProviderEditorError ? err.current?.label : '',
    action,
    result: status === 412 ? 'conflict' : 'failed',
    details: { code, status },
    revisionBefore: err instanceof ProviderEditorError ? err.current?.revision : '',
  })
}

function authPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

async function clearStoredAuthProvider(profile: string, poolKey: string) {
  try {
    const authPath = authPathForProfile(profile)
    if (!existsSync(authPath)) return

    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    let changed = false
    if (auth.providers && Object.prototype.hasOwnProperty.call(auth.providers, poolKey)) {
      delete auth.providers[poolKey]
      changed = true
    }
    if (auth.credential_pool && Object.prototype.hasOwnProperty.call(auth.credential_pool, poolKey)) {
      delete auth.credential_pool[poolKey]
      changed = true
    }
    if (changed) {
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
    }
  } catch (err: any) { logger.error(err, 'Failed to clear auth credentials for %s', poolKey) }
}

function normalizeApiMode(value: unknown): ProviderApiMode | undefined {
  const apiMode = String(value || '').trim()
  return apiMode === 'chat_completions' ||
    apiMode === 'codex_responses' ||
    apiMode === 'anthropic_messages' ||
    apiMode === 'bedrock_converse' ||
    apiMode === 'codex_app_server'
    ? apiMode
    : undefined
}

function buildProviderEntry(name: string, base_url: string, api_key: string, model: string, context_length?: number, api_mode?: ProviderApiMode) {
  const entry: any = { name, base_url, api_key, model }
  if (api_mode) {
    entry.api_mode = api_mode
  }
  if (context_length && context_length > 0) {
    entry.models = { [model]: { context_length } }
  }
  return entry
}

function normalizeBaseUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '')
}

function builtinBaseUrl(poolKey: string, requestedBaseUrl: string): string {
  return requestedBaseUrl || PROVIDER_PRESETS.find(p => p.value === poolKey)?.base_url || ''
}

function shouldPersistBuiltinBaseUrl(poolKey: string, requestedBaseUrl: string): boolean {
  const presetBaseUrl = PROVIDER_PRESETS.find(p => p.value === poolKey)?.base_url || ''
  if (!requestedBaseUrl || !presetBaseUrl) return !!requestedBaseUrl
  return normalizeBaseUrl(requestedBaseUrl) !== normalizeBaseUrl(presetBaseUrl)
}

function providerKeyForCustomName(name: string): string {
  return `custom:${String(name || '').trim().toLowerCase().replace(/ /g, '-')}`
}

function findLegacyCustomProviderIndex(config: any, poolKey: string): number {
  return Array.isArray(config.custom_providers)
    ? (config.custom_providers as any[]).findIndex((e: any) => providerKeyForCustomName(e?.name) === poolKey)
    : -1
}

function findProviderDictKey(config: any, poolKey: string, requestedProviderKey = ''): string {
  const dict = config.providers
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return ''
  if (requestedProviderKey && Object.prototype.hasOwnProperty.call(dict, requestedProviderKey)) {
    return requestedProviderKey
  }
  for (const [key, entry] of Object.entries(dict)) {
    const normalized = normalizeCustomProviderEntry(entry, key, 'providers')
    if (normalized && providerKeyForCustomName(normalized.name) === poolKey) return key
  }
  return ''
}

export async function getEditor(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  try {
    const detail = await getProviderEditorDetail(requestedProfile(ctx), providerId)
    setRevisionHeader(ctx, detail.revision)
    ctx.body = { provider: detail }
  } catch (error) {
    respondEditorError(ctx, error, providerId, 'provider.editor.read')
  }
}

export async function patchEditor(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  const patch = (ctx.request.body || {}) as ProviderEditorPatch
  try {
    const profile = requestedProfile(ctx)
    const result = await updateProviderEditorDetail(
      profile,
      providerId,
      patch,
      expectedRevision(ctx),
    )
    if (result.changed.some(field => field === 'api_key_replaced' || field === 'api_key_cleared' || field === 'base_url' || field === 'api_mode')) {
      invalidateProviderRuntime(profile, providerId)
    }
    setRevisionHeader(ctx, result.detail.revision)
    appendAuditSafely({
      actor: actorForAudit(ctx),
      profile: requestedProfile(ctx),
      providerId,
      providerLabel: result.detail.label,
      action: 'provider.editor.update',
      fields: result.changed,
      details: { credential_configured: result.detail.credential_configured },
      revisionBefore: result.before.revision,
      revisionAfter: result.detail.revision,
    })
    ctx.body = { success: true, provider: result.detail, changed: result.changed }
  } catch (error) {
    respondEditorError(ctx, error, providerId, 'provider.editor.update')
  }
}

export async function patchEditorContexts(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  const body = (ctx.request.body || {}) as { revision?: string; context_lengths?: Record<string, number | null> }
  try {
    const result = await updateProviderContextLengths(
      requestedProfile(ctx),
      providerId,
      body.context_lengths || {},
      expectedRevision(ctx),
    )
    setRevisionHeader(ctx, result.detail.revision)
    appendAuditSafely({
      actor: actorForAudit(ctx),
      profile: requestedProfile(ctx),
      providerId,
      providerLabel: result.detail.label,
      action: 'provider.editor.context.update',
      fields: result.changed,
      revisionBefore: result.before.revision,
      revisionAfter: result.detail.revision,
    })
    ctx.body = { success: true, provider: result.detail, changed: result.changed }
  } catch (error) {
    respondEditorError(ctx, error, providerId, 'provider.editor.context.update')
  }
}

export async function testEditor(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  try {
    const result = await testProviderEditorDraft(
      requestedProfile(ctx),
      providerId,
      (ctx.request.body || {}) as ProviderEditorPatch,
    )
    ctx.body = { success: true, ...result }
  } catch (error) {
    const err = error as any
    if (err instanceof ProviderEditorError) {
      ctx.status = 200
      ctx.body = { success: false, error: err.message, code: err.code }
      return
    }
    respondEditorError(ctx, error, providerId, 'provider.editor.test')
  }
}

export async function refreshModels(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  const confirm = !!(ctx.request.body && typeof ctx.request.body === 'object' && (ctx.request.body as any).confirm)
  try {
    const result = await refreshProviderModels(requestedProfile(ctx), providerId, { confirm })
    appendAuditSafely({
      actor: actorForAudit(ctx),
      profile: requestedProfile(ctx),
      providerId,
      action: result.applied ? 'provider.models.refresh' : 'provider.models.refresh.preview',
      fields: ['models'],
      details: {
        applied: result.applied,
        requires_confirmation: result.requires_confirmation,
        added: result.diff.added.length,
        removed: result.diff.removed.length,
        model_count: result.models.length,
      },
    })
    ctx.body = { success: true, ...result }
  } catch (error) {
    respondEditorError(ctx, error, providerId, 'provider.models.refresh')
  }
}

export async function restoreModels(ctx: any) {
  const providerId = decodeURIComponent(ctx.params.poolKey)
  try {
    const result = await restoreProviderModels(requestedProfile(ctx), providerId)
    appendAuditSafely({
      actor: actorForAudit(ctx),
      profile: requestedProfile(ctx),
      providerId,
      action: 'provider.models.restore',
      fields: ['models'],
      details: {
        model_count: result.models.length,
        restore_available: result.restore_available,
      },
    })
    ctx.body = { success: true, ...result }
  } catch (error) {
    respondEditorError(ctx, error, providerId, 'provider.models.restore')
  }
}

export async function create(ctx: any) {
  const { name, base_url, api_key, model, context_length, providerKey, api_mode } = ctx.request.body as {
    name: string; base_url: string; api_key: string; model: string; context_length?: number; providerKey?: string | null; api_mode?: ProviderApiMode
  }
  const normalizedName = String(name || '').trim()
  const poolKey = providerKey || `custom:${normalizedName.toLowerCase().replace(/ /g, '-')}`
  const isBuiltin = poolKey in PROVIDER_ENV_MAP
  const effectiveBaseUrl = poolKey === OPENCODE_FREE_PROVIDER ? OPENCODE_FREE_BASE_URL : isBuiltin ? builtinBaseUrl(poolKey, base_url) : base_url
  const customApiMode = normalizeApiMode(api_mode)
  if (!normalizedName || !effectiveBaseUrl || !model) {
    ctx.status = 400; ctx.body = { error: 'Missing name, base_url, or model' }; return
  }
  if (!api_key && !OPTIONAL_API_KEY_PROVIDERS.has(String(providerKey || ''))) {
    ctx.status = 400; ctx.body = { error: 'Missing API key' }; return
  }
  if (poolKey === OPENCODE_FREE_PROVIDER && !isOpenCodeFreeModel(model)) {
    ctx.status = 400; ctx.body = { error: 'Select an OpenCode Free model' }; return
  }
  try {
    const profile = requestedProfile(ctx)
    await updateConfigYamlForProfile(profile, async (config) => {
      if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
      if (!isBuiltin) {
        if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
        const existing = (config.custom_providers as any[]).find(
          (e: any) => `custom:${e.name}` === poolKey
        )
        if (existing) {
          existing.base_url = effectiveBaseUrl
          existing.api_key = api_key
          existing.model = model
          const preset = PROVIDER_PRESETS.find(p => p.value === poolKey.replace('custom:', ''))
          if (preset?.api_mode) existing.api_mode = preset.api_mode
          else if (customApiMode) existing.api_mode = customApiMode
          if (context_length && context_length > 0) {
            if (!existing.models) existing.models = {}
            existing.models[model] = existing.models[model] || {}
            existing.models[model].context_length = context_length
          }
        } else {
          const entry = buildProviderEntry(normalizedName.toLowerCase().replace(/ /g, '-'), effectiveBaseUrl, api_key, model, context_length, customApiMode)
          const preset = PROVIDER_PRESETS.find(p => p.value === poolKey.replace('custom:', ''))
          if (preset?.api_mode) entry.api_mode = preset.api_mode
          config.custom_providers.push(entry)
        }
        config.model.default = model
        config.model.provider = poolKey
      } else {
        if (PROVIDER_ENV_MAP[poolKey].api_key_env) {
          await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].api_key_env, api_key)
          if (PROVIDER_ENV_MAP[poolKey].base_url_env && shouldPersistBuiltinBaseUrl(poolKey, base_url)) { await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].base_url_env, effectiveBaseUrl) }
          config.model.default = model
          config.model.provider = poolKey
        } else if (DIRECT_CONFIG_PROVIDERS.has(poolKey)) {
          if (PROVIDER_ENV_MAP[poolKey].base_url_env && shouldPersistBuiltinBaseUrl(poolKey, base_url)) { await saveEnvValueForProfile(profile, PROVIDER_ENV_MAP[poolKey].base_url_env, effectiveBaseUrl) }
          config.model.default = model
          config.model.provider = poolKey
        } else {
          if (!Array.isArray(config.custom_providers)) { config.custom_providers = [] }
          const existing = (config.custom_providers as any[]).find(
            (e: any) => `custom:${e.name}` === `custom:${poolKey}`
          )
          if (existing) {
            existing.base_url = effectiveBaseUrl
            existing.api_key = api_key
            existing.model = model
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) existing.api_mode = preset.api_mode
            else if (customApiMode) existing.api_mode = customApiMode
            if (context_length && context_length > 0) {
              if (!existing.models) existing.models = {}
              existing.models[model] = existing.models[model] || {}
              existing.models[model].context_length = context_length
            }
          } else {
            const entry = buildProviderEntry(poolKey, effectiveBaseUrl, api_key, model, context_length, customApiMode)
            const preset = PROVIDER_PRESETS.find(p => p.value === poolKey)
            if (preset?.api_mode) entry.api_mode = preset.api_mode
            config.custom_providers.push(entry)
          }
          config.model.default = model
          config.model.provider = `custom:${poolKey}`
        }
      }
      delete config.model.base_url
      delete config.model.api_key
      return config
    })
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function update(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  const { name, base_url, api_key, model, api_mode } = ctx.request.body as {
    name?: string; base_url?: string; api_key?: string; model?: string; api_mode?: ProviderApiMode
  }
  const customApiMode = normalizeApiMode(api_mode)
  try {
    const profile = requestedProfile(ctx)
    const isCustom = poolKey.startsWith('custom:')
    if (isCustom) {
      const found = await updateConfigYamlForProfile(profile, (config) => {
        if (!Array.isArray(config.custom_providers)) return { data: config, result: false, write: false }
        const entry = (config.custom_providers as any[]).find((e: any) => {
          return `custom:${e.name.trim().toLowerCase().replace(/ /g, '-')}` === poolKey
        })
        if (!entry) return { data: config, result: false, write: false }
        if (name !== undefined) entry.name = name
        if (base_url !== undefined) entry.base_url = base_url
        if (api_key !== undefined) entry.api_key = api_key
        if (model !== undefined) entry.model = model
        if (customApiMode !== undefined) entry.api_mode = customApiMode
        return { data: config, result: true }
      })
      if (!found) {
        ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
      }
    } else {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping?.api_key_env) {
        ctx.status = 400; ctx.body = { error: `Cannot update credentials for "${poolKey}"` }; return
      }
      if (api_key !== undefined) { await saveEnvValueForProfile(profile, envMapping.api_key_env, api_key) }
    }
    invalidateProviderRuntime(profile, poolKey)
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}

export async function remove(ctx: any) {
  const poolKey = decodeURIComponent(ctx.params.poolKey)
  const query = ctx.query as { source?: string; providerKey?: string }
  const requestedSource = query?.source === 'providers' || query?.source === 'custom_providers'
    ? query.source
    : ''
  const requestedProviderKey = typeof query?.providerKey === 'string' ? query.providerKey.trim() : ''
  try {
    const profile = requestedProfile(ctx)
    const isCustom = poolKey.startsWith('custom:')
    const removed = await updateConfigYamlForProfile(profile, async (config) => {
      if (isCustom) {
        const removeLegacy = requestedSource !== 'providers'
        const removeDict = requestedSource !== 'custom_providers'
        let didRemove = false
        if (removeLegacy) {
          const idx = findLegacyCustomProviderIndex(config, poolKey)
          if (idx !== -1) {
            ;(config.custom_providers as any[]).splice(idx, 1)
            didRemove = true
          }
        }
        if (!didRemove && removeDict) {
          const dictKey = findProviderDictKey(config, poolKey, requestedProviderKey)
          if (dictKey) {
            delete config.providers[dictKey]
            didRemove = true
          }
        }
        if (!didRemove) return { data: config, result: false, write: false }
      } else {
        const envMapping = PROVIDER_ENV_MAP[poolKey]
        if (envMapping?.api_key_env) {
          await saveEnvValueForProfile(profile, envMapping.api_key_env, '')
        }
        if (envMapping?.base_url_env) {
          await saveEnvValueForProfile(profile, envMapping.base_url_env, '')
        }
      }
      if (config.model?.provider === poolKey) {
        const remaining = getCompatibleCustomProviders(config)
        if (remaining.length > 0) {
          const fallbackCp = remaining[0]
          const fallbackKey = providerKeyForCustomName(fallbackCp.name)
          if (typeof config.model !== 'object' || config.model === null) { config.model = {} }
          config.model.default = fallbackCp.model || Object.keys(fallbackCp.models || {})[0] || ''
          config.model.provider = fallbackKey
          delete config.model.base_url
          delete config.model.api_key
        } else {
          config.model = preservedModelKeys(config.model)
        }
      }
      return { data: config, result: true }
    })
    if (!removed) {
      ctx.status = 404; ctx.body = { error: `Custom provider "${poolKey}" not found` }; return
    }
    if (!isCustom) {
      const envMapping = PROVIDER_ENV_MAP[poolKey]
      if (!envMapping) {
        ctx.status = 404; ctx.body = { error: `Provider "${poolKey}" not found` }; return
      }
    }
    await clearStoredAuthProvider(profile, poolKey)
    invalidateProviderRuntime(profile, poolKey)
    // TODO: Test if provider works without gateway restart
    // try { await hermesCli.restartGateway() } catch (e: any) { logger.error(e, 'Gateway restart failed') }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
