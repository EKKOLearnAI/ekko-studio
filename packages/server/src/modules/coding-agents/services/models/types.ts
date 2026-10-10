import type { CodingAgentModel, CodingAgentModelScope, CodingAgentModelSource, CodingAgentModelStatus } from '../../contracts/models'

export class ModelDiscoveryError extends Error {
  constructor(readonly status: Exclude<CodingAgentModelStatus, 'ready' | 'empty'>) {
    super(`Native model discovery: ${status}`)
  }
}

export function discoveryError(value: unknown): ModelDiscoveryError {
  if (value instanceof ModelDiscoveryError) return value
  const error = value as { message?: unknown; code?: unknown } | null
  const message = typeof value === 'string' ? value : String(error?.message || '')
  if (/authenticat|unauthori[sz]ed|not.logged.in|sign.in|log.in.required|missing.api.key|no.api.key|401\b/i.test(message)) return new ModelDiscoveryError('auth_required')
  if (/unknown (?:option|command)|unrecognized|not supported|unsupported|method not found/i.test(message)) return new ModelDiscoveryError('unsupported')
  if (error?.code === 'ENOENT') return new ModelDiscoveryError('not_installed')
  return new ModelDiscoveryError('error')
}

export interface DiscoveryRpc {
  request(method: string, params?: unknown): Promise<any>
  notify(method: string, params?: unknown): void
  controlInitialize(): Promise<any>
}

export interface ModelDiscoveryContext {
  home: string
  cwd: string
  env: NodeJS.ProcessEnv
  run(args: string[]): Promise<{ stdout: string; stderr: string }>
  rpc<T>(args: string[], callback: (rpc: DiscoveryRpc) => Promise<T>, framing?: 'jsonl' | 'content-length'): Promise<T>
}

export interface DiscoveredModels {
  models: CodingAgentModel[]
  scope?: CodingAgentModelScope
}

export interface ModelDiscoveryAdapter {
  source: CodingAgentModelSource
  scope: CodingAgentModelScope
  discover(context: ModelDiscoveryContext): Promise<DiscoveredModels>
}

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  return clean ? clean.slice(0, 256) : undefined
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Pick public model metadata explicitly; never spread native account/config objects. */
export function normalizeModels(models: CodingAgentModel[]): CodingAgentModel[] {
  const seen = new Set<string>()
  return models.slice(0, 5000).flatMap(raw => {
    const id = text(raw.id)
    const provider = text(raw.provider)
    const key = JSON.stringify([provider, id])
    if (!id || seen.has(key)) return []
    seen.add(key)
    return [{
      id, name: text(raw.name) || id,
      ...(provider ? { provider } : {}),
      ...(typeof raw.isDefault === 'boolean' ? { isDefault: raw.isDefault } : {}),
      ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
      ...(positiveNumber(raw.contextWindow) ? { contextWindow: raw.contextWindow } : {}),
      ...(positiveNumber(raw.maxOutputTokens) ? { maxOutputTokens: raw.maxOutputTokens } : {}),
      ...(Array.isArray(raw.reasoningEfforts) ? { reasoningEfforts: [...new Set(raw.reasoningEfforts.slice(0, 32).map(text).filter((item): item is string => Boolean(item)))] } : {}),
      ...(Array.isArray(raw.inputModalities) ? { inputModalities: [...new Set(raw.inputModalities.slice(0, 16).map(text).filter((item): item is string => Boolean(item)))] } : {}),
    }]
  })
}
