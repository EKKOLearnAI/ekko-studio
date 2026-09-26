import {
  APIError, APITimeoutError, APIUserAbortError, TypeSafeClient,
  choice, noul, score,
  type Questions, type SystemOneRequest, type SystemOneResult,
} from '@typesafe-ai/sdk'
import { JevError, readJevCredentials, type JevCredentialSettings } from './settings'

export function parseJevRequest(input: unknown): SystemOneRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JevError('Invalid JEV request')
  const value = input as Record<string, unknown>
  const entry = (item: unknown) => item === null || typeof item === 'string' || typeof item === 'object'
  if (!Object.hasOwn(value, 'state') || !entry(value.state)) throw new JevError('JEV state must be text, JSON object, array or null')
  const questions = value.questions
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
    throw new JevError('At least one JEV question is required')
  }
  for (const question of Object.values(questions)) {
    if (!question || typeof question !== 'object' || Array.isArray(question)
      || !['choice', 'score', 'noul'].includes(question.type)
      || (question.instructions !== undefined && !entry(question.instructions))) throw new JevError('Invalid JEV question')
    const criteria = question.criteria
    if (question.type === 'choice' && (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)
      || Object.keys(criteria).length < 2 || !Object.values(criteria).every(entry))) throw new JevError('Choice requires at least two named options')
    if (question.type === 'score' && (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every(entry))) {
      throw new JevError('Score requires at least two ordered levels')
    }
    if (question.type === 'noul' && criteria != null && (typeof criteria !== 'object' || Array.isArray(criteria)
      || Object.keys(criteria).some(key => key !== 'true' && key !== 'false') || !Object.values(criteria).every(entry))) {
      throw new JevError('Invalid Noul criteria')
    }
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)) {
    throw new JevError('Invalid JEV model')
  }
  return { state: value.state as SystemOneRequest['state'], questions: questions as Questions,
    ...(value.model === undefined ? {} : { model: (value.model as string).trim() }) }
}


function sidecarTransportReason(error: unknown): unknown {
  let current = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
    seen.add(current)
    if ('sidecarReason' in current) return (current as { sidecarReason?: unknown }).sidecarReason
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return undefined
}

/** Internal transport shared by the manual API and the guarded sidecar. */
export async function evaluateJevWithCredentials<Q extends Questions>(
  settings: JevCredentialSettings,
  request: SystemOneRequest<Q>,
  options: { signal?: AbortSignal; timeoutMs?: number; beforeFetch?: () => Promise<void> } = {},
): Promise<SystemOneResult<Q>> {
  const payload = parseJevRequest(request)
  if (!settings.apiKey) throw new JevError('JEV API key is not configured for this Profile', 409, 'jev_not_configured')
  let fetchCount = 0
  const client = new TypeSafeClient({
    apiKey: settings.apiKey, baseURL: settings.baseUrl, defaultModel: settings.model,
    timeout: Math.max(1, Math.min(options.timeoutMs ?? settings.timeoutMs, settings.timeoutMs)),
    retry: { maxRetries: 0 }, logLevel: 'off',
    fetch: async (url, init) => {
      fetchCount += 1
      if (fetchCount > 1) throw new JevError('JEV transport attempted an unexpected additional request', 502, 'jev_request_failed')
      await options.beforeFetch?.()
      return fetch(url, { ...init, redirect: 'error' })
    },
  })
  try {
    options.signal?.throwIfAborted()
    return await client.systemOne(payload as SystemOneRequest<Q>, { signal: options.signal })
  } catch (error) {
    const guardedReason = sidecarTransportReason(error)
    if (guardedReason) throw Object.assign(new Error(String(guardedReason)), { sidecarReason: guardedReason })
    if (error instanceof JevError) throw error
    if (error instanceof APITimeoutError) throw new JevError('JEV request timed out', 504, 'jev_timeout')
    if (error instanceof APIUserAbortError || options.signal?.aborted) throw new JevError('JEV request cancelled', 499, 'jev_cancelled')
    if (error instanceof APIError) {
      const code = [401, 403].includes(error.status) ? 'jev_auth_failed' : error.status === 429 ? 'jev_rate_limited' : 'jev_provider_error'
      throw new JevError(`JEV provider returned HTTP ${error.status}`, 502, code)
    }
    throw new JevError('JEV request failed', 502, 'jev_request_failed')
  }
}

/** Shared server entry point. Callers must pass their own authorized profile. */
export async function evaluateJev<Q extends Questions>(
  profile: string,
  request: SystemOneRequest<Q>,
  options: { signal?: AbortSignal } = {},
): Promise<SystemOneResult<Q>> {
  return evaluateJevWithCredentials(await readJevCredentials(profile), request, options)
}

export async function testJev(profile: string) {
  const started = Date.now()
  const result = await evaluateJev(profile, {
    state: 'The service is working correctly.',
    questions: {
      sentiment: choice('What is the sentiment?', { positive: null, negative: null }),
      quality: score('How well is the service working?', ['Poorly', 'Well']),
      working: noul('Is the service working?'),
    },
  })
  return { ...result, durationMs: Date.now() - started }
}
