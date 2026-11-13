/** Provider endpoint families shared by all Coding Agent proxies. */
export type AgentEndpointKind = 'chat_completions' | 'responses' | 'anthropic_messages'

function normalizedBaseUrl(baseUrl: string): URL {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('baseUrl is required')
  return new URL(trimmed)
}

function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '')
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function pathEndsWith(pathname: string, suffix: string): boolean {
  return pathname.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)
}

function looksLikeOpenAiRoot(pathname: string): boolean {
  const path = pathname.toLowerCase()
  const segments = path.split('/').filter(Boolean)
  const last = segments[segments.length - 1] || ''
  if (/^v\d+(?:beta)?$/.test(last)) return true
  if (last === 'openai') return true
  if (/\/api\/paas\/v\d+$/.test(path)) return true
  if (/\/coding\/v\d+$/.test(path)) return true
  if (/\/step_plan\/v\d+$/.test(path)) return true
  return false
}

function looksLikeAnthropicRoot(pathname: string): boolean {
  const path = pathname.toLowerCase()
  const segments = path.split('/').filter(Boolean)
  const last = segments[segments.length - 1] || ''
  return /^v\d+(?:beta)?$/.test(last)
}

export function chatCompletionsUrl(baseUrl: string): string {
  const url = normalizedBaseUrl(baseUrl)
  const path = normalizedPath(url)
  const base = url.toString().replace(/\/+$/, '')
  if (pathEndsWith(path, 'chat/completions')) return base
  if (looksLikeOpenAiRoot(path)) return appendPath(base, 'chat/completions')
  return appendPath(base, 'v1/chat/completions')
}

export function responsesUrl(baseUrl: string): string {
  const url = normalizedBaseUrl(baseUrl)
  const path = normalizedPath(url)
  const base = url.toString().replace(/\/+$/, '')
  if (pathEndsWith(path, 'responses')) return base
  if (looksLikeOpenAiRoot(path)) return appendPath(base, 'responses')
  return appendPath(base, 'v1/responses')
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const url = normalizedBaseUrl(baseUrl)
  const path = normalizedPath(url)
  const base = url.toString().replace(/\/+$/, '')
  if (pathEndsWith(path, 'messages')) return base
  if (looksLikeAnthropicRoot(path)) return appendPath(base, 'messages')
  return appendPath(base, 'v1/messages')
}

export function providerEndpointUrl(kind: AgentEndpointKind, baseUrl: string): string {
  if (kind === 'chat_completions') return chatCompletionsUrl(baseUrl)
  if (kind === 'responses') return responsesUrl(baseUrl)
  return anthropicMessagesUrl(baseUrl)
}
