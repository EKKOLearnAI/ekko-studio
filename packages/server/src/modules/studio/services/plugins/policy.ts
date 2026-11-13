import type { ApiRequest, Json, PluginIdentity, Schema } from '../../contracts/plugins'
import { PluginError } from './errors'

export function pluginApiPath(path: string, identity: PluginIdentity, options: ApiRequest): URL {
  if (!options || typeof options !== 'object' || Array.isArray(options) || options.method && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method)) throw new PluginError('Invalid API request options')
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) throw new PluginError('Use a relative Studio API path')
  const url = new URL(path, 'http://plugin.local')
  if (url.origin !== 'http://plugin.local' || !url.pathname.startsWith('/api/') || /\/\.\.?\//.test(path)) throw new PluginError('Invalid Studio API path')
  if (/^\/api\/(?:studio\/(?:desktop-browser|plugins|auth|models\/(?:api-keys|cloud-link))|auth)(?:\/|$)/i.test(url.pathname)) throw new PluginError('Account and plugin administration is unavailable through plugin API', 'PLUGIN_FORBIDDEN', 403)
  if (/^\/api\/studio\/agents\/[^/]+\/(?:upgrade|check-update)(?:\/|$)/i.test(url.pathname)) throw new PluginError('Agent administration is unavailable through plugin API', 'PLUGIN_FORBIDDEN', 403)
  for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value))
  const body = options.body && typeof options.body === 'object' && !Array.isArray(options.body) ? options.body : {}
  if (url.searchParams.has('profile') && url.searchParams.get('profile') !== identity.profile || body.profile !== undefined && body.profile !== identity.profile) throw new PluginError('Plugin API cannot change its bound profile', 'PLUGIN_SCOPE', 403)
  const profileRoute = /^\/api\/hermes\/profiles\/([^/]+)/i.exec(url.pathname)
  if (profileRoute && decodeURIComponent(profileRoute[1]) !== identity.profile) throw new PluginError('Plugin API cannot change its bound profile', 'PLUGIN_SCOPE', 403)
  url.searchParams.set('profile', identity.profile)
  return url
}
export function publicConfig(value: Json, schema?: Schema): Json | undefined {
  if (schema?.secret) return undefined
  if (Array.isArray(value)) return value.map(item => publicConfig(item, schema?.items) ?? null)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const result = publicConfig(item, schema?.properties?.[key]); return result === undefined ? [] : [[key, result]]
  }))
}
export function mergeSecrets(value: Json, previous: Json, schema?: Schema): Json {
  if (Array.isArray(value)) return value.map((item, index) => mergeSecrets(item, Array.isArray(previous) ? previous[index] : null, schema?.items))
  if (!value || typeof value !== 'object') return value
  const old = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const result = { ...value }
  for (const [key, field] of Object.entries(schema?.properties || {})) {
    if (field.secret && result[key] === undefined && old[key] !== undefined) result[key] = old[key]
    else if (result[key] !== undefined) result[key] = mergeSecrets(result[key], old[key] ?? null, field)
  }
  return result
}
