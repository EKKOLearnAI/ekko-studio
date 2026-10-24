export class ModelApiError extends Error {
  constructor(message: string, readonly status = 400, readonly param: string | null = null, readonly code: string | null = null) {
    super(message)
  }
}

/** Extra context used to classify failures that came from the upstream provider. */
export interface ModelApiErrorContext {
  /** Upstream timeout that was applied to this request, in milliseconds. */
  timeoutMs?: number
}

const PROVIDER_FAILED_MESSAGE = 'The model provider request failed.'

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

interface ErrorClassification {
  status: number
  message: string
  code: string | null
  param: string | null
}

function stringField(error: unknown, field: string): string | undefined {
  const value = (error as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'string' && value ? value : undefined
}

function numberField(error: unknown, field: string): number | undefined {
  const value = (error as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timeoutMessage(context: ModelApiErrorContext): string {
  const limit = context.timeoutMs && context.timeoutMs > 0 ? `${Math.round(context.timeoutMs / 1000)}s` : 'the configured timeout'
  return `The model provider did not answer within ${limit}. Retry, or raise the model request timeout.`
}

function httpClassification(status: number, context: ModelApiErrorContext): ErrorClassification {
  if (status === 408) return { status: 504, message: timeoutMessage(context), code: 'provider_timeout', param: null }
  if (status === 401 || status === 403) {
    return { status: 502, message: `The model provider rejected the stored credentials (HTTP ${status}).`, code: 'provider_unauthorized', param: null }
  }
  if (status === 429) {
    return { status: 502, message: 'The model provider is rate limiting this key (HTTP 429). Retry later.', code: 'provider_rate_limited', param: null }
  }
  if (status >= 500) return { status: 502, message: `The model provider failed to answer (HTTP ${status}).`, code: 'provider_unavailable', param: null }
  return { status: 502, message: `The model provider rejected the request (HTTP ${status}).`, code: 'provider_rejected_request', param: null }
}

/**
 * Classify an upstream failure without echoing provider payloads, so callers can tell
 * a timeout, a bad credential, an unreachable host and a provider outage apart instead
 * of receiving one anonymous `502`. The raw error is logged by the caller.
 */
function classifyUpstreamError(error: unknown, context: ModelApiErrorContext): ErrorClassification {
  const name = stringField(error, 'name')
  const code = stringField(error, 'code')
  const providerStatus = numberField(error, 'statusCode') ?? numberField(error, 'status')
  // AbortSignal.timeout() surfaces a TimeoutError; transports use the codes below.
  if (name === 'TimeoutError' || (code !== undefined && TIMEOUT_CODES.has(code))) {
    return { status: 504, message: timeoutMessage(context), code: 'provider_timeout', param: null }
  }
  if (providerStatus !== undefined && providerStatus >= 400) return httpClassification(providerStatus, context)
  if (code !== undefined && TLS_CODES.has(code)) {
    return { status: 502, message: 'The model provider TLS certificate could not be verified.', code: 'provider_tls_error', param: null }
  }
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return { status: 502, message: 'The model provider could not be reached.', code: 'provider_unreachable', param: null }
  }
  if (name === 'AbortError') {
    return { status: 499, message: 'The request was cancelled before the model provider answered.', code: 'request_cancelled', param: null }
  }
  return { status: 502, message: PROVIDER_FAILED_MESSAGE, code: 'provider_request_failed', param: null }
}

function defaultCode(status: number): string | null {
  return status === 404 ? 'model_not_found' : status === 501 ? 'unsupported_api_mode' : null
}

export function modelApiErrorBody(error: unknown, context: ModelApiErrorContext = {}) {
  const failure: ErrorClassification = error instanceof ModelApiError
    ? { status: error.status, message: error.message, code: error.code ?? defaultCode(error.status), param: error.param }
    : classifyUpstreamError(error, context)
  return {
    status: failure.status,
    body: { error: {
      message: failure.message,
      type: failure.status === 429 ? 'insufficient_quota' : failure.status < 500 ? 'invalid_request_error' : 'server_error',
      param: failure.param,
      code: failure.code,
    } },
  }
}
