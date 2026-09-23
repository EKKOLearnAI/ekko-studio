import { AsyncLocalStorage } from 'node:async_hooks'
import {
  APIError, APITimeoutError, APIUserAbortError, TypeSafeClient,
  type Questions, type SystemOneRequest, type SystemOneResult,
} from '@typesafe-ai/sdk'
import { resolveEkkoJevConfig, type EkkoJevConfig, type EkkoJevOverrides } from './config'

export type EkkoJevErrorCode =
  | 'jev_invalid_request' | 'jev_timeout' | 'jev_cancelled'
  | 'jev_auth_failed' | 'jev_rate_limited' | 'jev_provider_error' | 'jev_request_failed'

export class EkkoJevError extends Error {
  constructor(message: string, readonly code: EkkoJevErrorCode) {
    super(message)
    this.name = 'EkkoJevError'
  }
}

export interface EkkoJevSettings extends Omit<EkkoJevConfig, 'apiKey'> {
  hasApiKey: boolean
}

const runContext = new AsyncLocalStorage<{ client: EkkoJevClient; signal?: AbortSignal }>()

/** Internal run-local access; memory services can be shared across profiles. */
export function currentEkkoJevRun(): { client: EkkoJevClient; signal?: AbortSignal } | undefined {
  return runContext.getStore()
}

/** Ekko-owned evaluator. Receives configuration values only; never reads or writes files. */
export class EkkoJevClient {
  #config: EkkoJevConfig

  constructor(config?: EkkoJevOverrides) {
    this.#config = resolveEkkoJevConfig(config)
  }

  /** Replace the effective in-memory settings. Already-started requests retain their snapshot. */
  configure(config?: EkkoJevOverrides): void {
    this.#config = resolveEkkoJevConfig(config)
  }

  /** Freeze this run's effective settings without changing the shared memory service. */
  runScoped<T>(signal: AbortSignal | undefined, operation: () => T): T {
    return runContext.run({ client: new EkkoJevClient(this.#config), signal }, operation)
  }

  get available(): boolean {
    return this.#config.enabled && Boolean(this.#config.apiKey)
  }

  get settings(): EkkoJevSettings {
    const { apiKey, ...settings } = this.#config
    return { ...settings, hasApiKey: Boolean(apiKey) }
  }

  /** Disabled/unconfigured JEV returns undefined without contacting any provider. */
  async evaluate<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: { signal?: AbortSignal } = {},
  ): Promise<SystemOneResult<Q> | undefined> {
    if (!this.available) return undefined
    validateRequest(request)
    const config = this.#config
    try {
      options.signal?.throwIfAborted()
      const client = new TypeSafeClient({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        defaultModel: config.model,
        timeout: config.timeoutMs,
        retry: { maxRetries: 0 },
        logLevel: 'off',
        fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
      })
      return await client.systemOne(request, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted || error instanceof APIUserAbortError) {
        throw new EkkoJevError('JEV request cancelled.', 'jev_cancelled')
      }
      if (error instanceof APITimeoutError) throw new EkkoJevError('JEV request timed out.', 'jev_timeout')
      if (error instanceof APIError) {
        const code = [401, 403].includes(error.status) ? 'jev_auth_failed'
          : error.status === 429 ? 'jev_rate_limited' : 'jev_provider_error'
        throw new EkkoJevError(`JEV provider returned HTTP ${error.status}.`, code)
      }
      // Provider bodies and SDK errors may contain the input or credentials.
      throw new EkkoJevError('JEV request failed.', 'jev_request_failed')
    }
  }

  /** Optional enhancement: provider failures return undefined; cancellation and invalid input still reject. */
  async tryEvaluate<Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: { signal?: AbortSignal } = {},
  ): Promise<SystemOneResult<Q> | undefined> {
    try {
      return await this.evaluate(request, options)
    } catch (error) {
      if (error instanceof EkkoJevError && error.code !== 'jev_cancelled' && error.code !== 'jev_invalid_request') {
        return undefined
      }
      throw error
    }
  }
}

function validateRequest(input: unknown): asserts input is SystemOneRequest {
  const invalid = () => { throw new EkkoJevError('Invalid JEV evaluation request.', 'jev_invalid_request') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const value = input as Record<string, unknown>
  const entry = (item: unknown) => item === null || typeof item === 'string' || typeof item === 'object'
  if (!Object.hasOwn(value, 'state') || !entry(value.state)) return invalid()
  if (!value.questions || typeof value.questions !== 'object' || Array.isArray(value.questions)
    || !Object.keys(value.questions).length) return invalid()
  for (const item of Object.values(value.questions)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid()
    const question = item as Record<string, unknown>
    if (!['choice', 'score', 'noul'].includes(String(question.type))
      || (question.instructions !== undefined && !entry(question.instructions))) return invalid()
    const criteria = question.criteria
    if (question.type === 'choice' && (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)
      || Object.keys(criteria).length < 2 || !Object.values(criteria).every(entry))) return invalid()
    if (question.type === 'score' && (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every(entry))) return invalid()
    if (question.type === 'noul' && criteria != null && (typeof criteria !== 'object' || Array.isArray(criteria)
      || Object.keys(criteria).some(key => key !== 'true' && key !== 'false') || !Object.values(criteria).every(entry))) return invalid()
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)) return invalid()
}
