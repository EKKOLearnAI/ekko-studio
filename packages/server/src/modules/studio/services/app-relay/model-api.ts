import { issueCloudUsageReceipt, type CloudModelUsage } from '../model-api/cloud-usage'
import { findUserById } from '../../repositories/users-store'
import { listAppConnections } from '../../repositories/app-connections-store'
import { findModelApiKey } from '../model-api/keys'

interface Session {
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  reader?: ReadableStreamDefaultReader<Uint8Array>
  pending: Uint8Array
  reading: boolean
  bytes: number
  max: number
  userId: number
  cloudUserId: number
  apiKey: string
  releaseReceipt?: () => void
}

// Pull one bounded chunk immediately, including text/SSE. Generic App HTTP
// download sessions buffer textual responses and cannot carry model streams.
export class CloudModelApiSessions {
  private sessions = new Map<string, Session>()
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch, private reportUsage: (value: CloudModelUsage & { id: string }) => void = () => {}) {}

  private authorized(userId: number, cloudUserId: number, apiKey: string): boolean {
    return findModelApiKey(apiKey)?.userId === userId && findUserById(userId)?.status === 'active' && listAppConnections().some(connection =>
      connection.connection_type === 'cloud' && connection.user_id === userId
      && connection.cloud_user_id === cloudUserId && connection.revoked_at == null
      && !connection.cloud_revocation_pending && connection.token_expires_at > Math.floor(Date.now() / 1000))
  }
  authorize(input: Record<string, unknown>): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, status: 400, error: 'invalid_request' }
    const userId = Number(input.studioUserId), cloudUserId = Number(input.cloudUserId)
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(cloudUserId) || cloudUserId <= 0
      || typeof input.apiKey !== 'string' || !/^sk-ekko-[A-Za-z0-9_-]{43}$/.test(input.apiKey)) return { ok: false, status: 400, error: 'invalid_request' }
    // Read-only preflight: never fetch, allocate a stream or change usage/budget.
    return this.authorized(userId, cloudUserId, input.apiKey)
      ? { ok: true, version: 3 } : { ok: false, status: 403, error: 'cloud_model_access_denied' }
  }
  async open(input: Record<string, any>): Promise<Record<string, unknown>> {
    const { id, endpoint, apiKey } = input
    const userId = Number(input.studioUserId), cloudUserId = Number(input.cloudUserId)
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || !['models', 'responses'].includes(endpoint)
      || typeof apiKey !== 'string' || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(cloudUserId) || cloudUserId <= 0) return { ok: false, status: 400, error: 'invalid_request' }
    const authorization = this.authorize(input)
    if (authorization.ok !== true) return authorization
    if (this.sessions.has(id) || this.sessions.size >= 32) return { ok: false, status: 429, error: 'too_many_requests' }
    const body = Buffer.from(input.body || [])
    const max = Number(input.maxDownloadBytes)
    if (body.length > 20 * 1024 * 1024 || !Number.isSafeInteger(max) || max < 1 || max > 1024 * 1024 * 1024) {
      return { ok: false, status: 413, error: 'invalid_transfer_limits' }
    }
    const abort = new AbortController()
    const session: Session = { abort, timer: setTimeout(() => this.cancel(id), 10 * 60 * 1000), pending: new Uint8Array(), reading: false, bytes: 0, max, userId, cloudUserId, apiKey }
    session.timer.unref()
    this.sessions.set(id, session)
    try {
      const receipt = endpoint === 'responses' ? issueCloudUsageReceipt(userId, findModelApiKey(apiKey)!.id, usage => this.reportUsage({ id, ...usage })) : undefined
      session.releaseReceipt = receipt?.dispose
      const response = await this.fetchImpl(`${this.baseUrl}/api/ekko-studio/models/v1/${endpoint}`, {
        method: endpoint === 'models' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(receipt ? { 'x-studio-cloud-usage': receipt.token } : {}) },
        body: endpoint === 'responses' ? body : undefined,
        signal: abort.signal, redirect: 'error',
      })
      if (abort.signal.aborted || !this.authorized(userId, cloudUserId, apiKey)) throw new Error('cloud_model_access_denied')
      if (Number(response.headers.get('content-length')) > max) throw new Error('download_too_large')
      session.reader = response.body?.getReader()
      return { ok: true, status: response.status, contentType: response.headers.get('content-type') || 'application/json', requestId: response.headers.get('x-request-id') }
    } catch (error) {
      this.cancel(id)
      return { ok: false, status: error instanceof Error && error.message === 'download_too_large' ? 413 : 502, error: error instanceof Error && ['cloud_model_access_denied', 'download_too_large'].includes(error.message) ? error.message : 'model_api_upstream_failed' }
    }
  }
  async read(id: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(id)
    if (!session || session.reading) return { ok: false, error: 'stream_not_found' }
    session.reading = true
    try {
      if (!this.authorized(session.userId, session.cloudUserId, session.apiKey)) throw new Error('cloud_model_access_denied')
      let data = session.pending
      let done = false
      if (!data.length) {
        const result = session.reader ? await session.reader.read() : { done: true, value: undefined }
        data = result.value || new Uint8Array()
        done = !!result.done
      }
      if (session.abort.signal.aborted || !this.authorized(session.userId, session.cloudUserId, session.apiKey)) throw new Error('cloud_model_access_denied')
      const chunk = data.subarray(0, 32 * 1024)
      session.pending = data.subarray(chunk.length)
      session.bytes += chunk.length
      if (session.bytes > session.max) throw new Error('download_too_large')
      if (done) this.cancel(id)
      return { ok: true, data: Buffer.from(chunk), done }
    } catch (error) {
      this.cancel(id)
      return { ok: false, error: error instanceof Error && ['cloud_model_access_denied', 'download_too_large'].includes(error.message) ? error.message : 'upstream_read_failed' }
    } finally { session.reading = false }
  }
  cancel(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.releaseReceipt?.()
    clearTimeout(session.timer)
    session.abort.abort()
    void session.reader?.cancel().catch(() => {})
  }
  cancelAll(): void { for (const id of this.sessions.keys()) this.cancel(id) }
}
