import { describe, expect, it } from 'vitest'
import { ModelApiError, modelApiErrorBody } from '../../packages/server/src/modules/studio/services/model-api/errors'

const providerError = (message: string, statusCode: number) => Object.assign(new Error(message), { name: 'ModelProviderError', statusCode })
const codedError = (name: string, code: string) => Object.assign(new Error(`${name}: ${code}`), { name, code })
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause })

describe('Model API error classification', () => {
  it('keeps explicit Model API errors, including their status, param and default code', () => {
    expect(modelApiErrorBody(new ModelApiError('Model is not available.', 404, 'model')))
      .toMatchObject({ status: 404, body: { error: { message: 'Model is not available.', type: 'invalid_request_error', param: 'model', code: 'model_not_found' } } })
    expect(modelApiErrorBody(new ModelApiError('API key USD budget exhausted.', 429, null, 'insufficient_quota')))
      .toMatchObject({ status: 429, body: { error: { type: 'insufficient_quota', code: 'insufficient_quota' } } })
    expect(modelApiErrorBody(new ModelApiError('Unsupported.', 501, 'model')))
      .toMatchObject({ status: 501, body: { error: { code: 'unsupported_api_mode' } } })
  })

  it('reports an upstream timeout as 504 provider_timeout with the configured limit', () => {
    const body = modelApiErrorBody(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), { timeoutMs: 60_000 })
    expect(body.status).toBe(504)
    expect(body.body.error).toMatchObject({ type: 'server_error', code: 'provider_timeout' })
    expect(body.body.error.message).toContain('60s')
    expect(modelApiErrorBody(codedError('Error', 'UND_ERR_HEADERS_TIMEOUT')).body.error.code).toBe('provider_timeout')
  })

  it('never reports an upstream 429 as an exhausted Model API key budget', () => {
    const body = modelApiErrorBody(providerError('slow down', 429))
    expect(body.status).toBe(502)
    expect(body.body.error).toMatchObject({ type: 'server_error', code: 'provider_rate_limited' })
    expect(body.body.error.message).toContain('HTTP 429')
  })

  it.each([
    [401, 'provider_unauthorized'], [403, 'provider_unauthorized'], [400, 'provider_rejected_request'],
    [422, 'provider_rejected_request'], [500, 'provider_unavailable'], [503, 'provider_unavailable'],
  ])('maps an upstream HTTP %s to 502 %s', (statusCode, code) => {
    expect(modelApiErrorBody(providerError('upstream detail', statusCode))).toMatchObject({ status: 502, body: { error: { code } } })
  })

  it('classifies transport failures by cause', () => {
    expect(modelApiErrorBody(codedError('Error', 'ECONNREFUSED')).body.error.code).toBe('provider_unreachable')
    expect(modelApiErrorBody(codedError('Error', 'ENOTFOUND')).body.error.code).toBe('provider_unreachable')
    expect(modelApiErrorBody(codedError('Error', 'CERT_HAS_EXPIRED')).body.error.code).toBe('provider_tls_error')
    expect(modelApiErrorBody(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toMatchObject({ status: 499, body: { error: { code: 'request_cancelled' } } })
    expect(modelApiErrorBody(new Error('boom'))).toMatchObject({ status: 502, body: { error: { message: 'The model provider request failed.', code: 'provider_request_failed' } } })
  })

  it('classifies transport failures that fetch reports on the cause chain', () => {
    // untouched fetch failures arrive as TypeError('fetch failed') with the transport code nested on cause
    expect(modelApiErrorBody(fetchFailed(codedError('Error', 'ECONNREFUSED'))).body.error.code).toBe('provider_unreachable')
    expect(modelApiErrorBody(fetchFailed(codedError('Error', 'ECONNRESET'))).body.error.code).toBe('provider_unreachable')
    expect(modelApiErrorBody(fetchFailed(codedError('Error', 'CERT_HAS_EXPIRED'))).body.error.code).toBe('provider_tls_error')
    expect(modelApiErrorBody(fetchFailed(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))))
      .toMatchObject({ status: 504, body: { error: { code: 'provider_timeout' } } })
    expect(modelApiErrorBody(fetchFailed(codedError('Error', 'UND_ERR_CONNECT_TIMEOUT')), { timeoutMs: 30_000 }))
      .toMatchObject({ status: 504, body: { error: { code: 'provider_timeout' } } })
    expect(modelApiErrorBody(fetchFailed(new DOMException('The operation was aborted', 'AbortError'))))
      .toMatchObject({ status: 499, body: { error: { code: 'request_cancelled' } } })
  })

  it('classifies a nested upstream HTTP status and nested causes several levels deep', () => {
    expect(modelApiErrorBody(fetchFailed(providerError('nested detail', 401))))
      .toMatchObject({ status: 502, body: { error: { code: 'provider_unauthorized' } } })
    const twiceNested = fetchFailed(fetchFailed(codedError('Error', 'ENOTFOUND')))
    expect(modelApiErrorBody(twiceNested).body.error.code).toBe('provider_unreachable')
  })

  it('keeps cause-chain walking bounded and cycle-safe', () => {
    const selfReferencing: Error & { cause?: unknown } = new Error('fetch failed')
    selfReferencing.cause = selfReferencing
    expect(modelApiErrorBody(selfReferencing)).toMatchObject({ status: 502, body: { error: { code: 'provider_request_failed' } } })

    let deep: unknown = codedError('Error', 'ECONNREFUSED')
    for (let index = 0; index < 9; index += 1) deep = fetchFailed(deep)
    // classification must terminate on a deep chain instead of walking it without limit
    expect(modelApiErrorBody(deep).status).toBe(502)
  })

  it('does not echo provider payloads, URLs or credentials to the caller', () => {
    const leaked = 'https://amr-link.example/v1 failed with key sk-amr-secretvalue and body {"error":"quota"}'
    for (const error of [providerError(leaked, 400), codedError(leaked, 'ECONNRESET'), new Error(leaked)]) {
      expect(JSON.stringify(modelApiErrorBody(error))).not.toContain('sk-amr-secretvalue')
      expect(JSON.stringify(modelApiErrorBody(error))).not.toContain('amr-link.example')
    }
  })

  it('does not echo payloads or credentials carried by a nested cause', () => {
    const leaked = 'https://amr-link.example/v1 failed with key sk-amr-secretvalue'
    const body = modelApiErrorBody(fetchFailed(codedError(leaked, 'ECONNREFUSED')))
    expect(body.body.error.code).toBe('provider_unreachable')
    expect(JSON.stringify(body)).not.toContain('sk-amr-secretvalue')
    expect(JSON.stringify(body)).not.toContain('amr-link.example')
  })
})
