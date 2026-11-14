import type { PluginIdentity } from './core'

/** Header names are lowercase. Delete an entry to remove a header. */
export type PluginHttpHeaders = Record<string, string | string[] | undefined>
export interface PluginHttpRequest {
  method: string
  /** Origin-relative path and query, for example /api/example?limit=5. */
  url: string
  headers: PluginHttpHeaders
  /** Parsed JSON/form/text body. Unparsed uploads are not buffered by the host. */
  body: unknown
}
export interface PluginHttpResponse {
  status: number
  headers: PluginHttpHeaders
  /** Koa response body: JSON, text, Buffer, stream, null or undefined. */
  body: unknown
}
export interface PluginHttpContext {
  readonly originalUrl: string
  readonly request: Readonly<PluginHttpRequest>
  /** Absent before authentication; never falls back to the activating administrator. */
  readonly identity?: Readonly<PluginIdentity>
  readonly signal: AbortSignal
}
/** Backend-only, process-local interception of inbound Studio HTTP traffic. */
export interface PluginHttpInterceptor {
  name: string
  /** Request callbacks run in ascending order; response callbacks unwind in reverse. */
  priority?: number
  /** Mutate request, or return a complete response to skip remaining callbacks and routing. */
  onRequest?(request: PluginHttpRequest, ctx: PluginHttpContext): void | PluginHttpResponse | Promise<void | PluginHttpResponse>
  /** Mutate the response before Koa sends it. Already committed raw responses are excluded. */
  onResponse?(response: PluginHttpResponse, ctx: PluginHttpContext): void | Promise<void>
}
