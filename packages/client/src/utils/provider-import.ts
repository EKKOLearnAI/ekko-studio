import { shallowRef } from 'vue'

export interface ProviderImport {
  version: 1
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  /** `auto` leaves the provider without a fixed API mode so each model picks its own protocol. */
  apiMode: 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'auto'
}

const fields = new Set(['version', 'name', 'baseUrl', 'model', 'apiKey', 'apiMode'])
const modes = new Set(['chat_completions', 'codex_responses', 'anthropic_messages', 'auto'])

function text(value: unknown, max: number, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid provider import')
  const result = value.trim()
  if (!result && !optional) throw new Error('Invalid provider import')
  return result
}

export function parseProviderImport(encoded: unknown): ProviderImport {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid provider import')
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0))
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1
    || Object.keys(data).some(key => !fields.has(key))) throw new Error('Invalid provider import')
  const name = text(data.name, 80, data.name === undefined)
  if (name && !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) throw new Error('Invalid provider import')
  const baseUrl = text(data.baseUrl, 2048)
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash) throw new Error('Invalid provider import')
  const apiMode = data.apiMode ?? 'chat_completions'
  if (!modes.has(apiMode)) throw new Error('Invalid provider import')
  return { version: 1, name, baseUrl, model: text(data.model, 256, data.model === undefined), apiKey: text(data.apiKey, 8192, true), apiMode }
}

// Memory only: never persist API keys to browser storage or login redirect URLs.
export const pendingProviderImport = shallowRef<{ draft?: ProviderImport; invalid?: boolean } | null>(null)

export function captureProviderImport(encoded: unknown): void {
  try { pendingProviderImport.value = { draft: parseProviderImport(encoded) } }
  catch { pendingProviderImport.value = { invalid: true } }
}
