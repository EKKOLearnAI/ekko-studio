import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import YAML from 'js-yaml'
import { safeFileStore } from '../../public/safe-file-store'
import { providerAccountHome } from './account-store'

interface RouteSource { profile?: string; provider: string }
type Routes = Record<string, RouteSource>

export function qualifyModelRoute(provider: string, model: string): string {
  return `${provider.replaceAll('%', '%25').replaceAll('/', '%2F')}/${model}`
}

export function splitModelRoute(value: string): { namespace: string; model: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  try { return { namespace: decodeURIComponent(value.slice(0, slash)), model: value.slice(slash + 1) } } catch { return null }
}

export function canonicalProviderId(profile: string, provider: string): string {
  if (!provider) return provider
  let imports: Record<string, Record<string, string>>
  let aliases: Record<string, string>
  try {
    const home = providerAccountHome()
    const state = JSON.parse(readFileSync(join(home, 'pool.json'), 'utf8'))
    imports = state.imports || {}
    aliases = state.aliases || {}
    const cfg = YAML.load(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, any>
    // A current account identity always wins over a legacy Profile alias.
    if (Object.hasOwn(cfg?.providers || {}, provider)) return provider
  }
  catch (error: any) { if (error.code === 'ENOENT') return provider; throw error }
  if (aliases[provider]) return aliases[provider]
  if (imports[profile]?.[provider]) return imports[profile][provider]
  const candidates = [...new Set(Object.values(imports).map(aliases => aliases[provider]).filter(Boolean))]
  return candidates.length === 1 ? candidates[0] : provider
}

export async function providerRouteNamespace(profile: string, provider: string): Promise<string> {
  provider = canonicalProviderId(profile, provider)
  const path = join(providerAccountHome(), 'routes.json')
  const namespace = await safeFileStore.updateTexts<string>([path], current => {
    const routes: Routes = JSON.parse(current[path] || '{}')
    const base = provider.replace(/^custom[:_]/, '')
    let name = base
    if (Object.hasOwn(routes, name) && routes[name].provider !== provider) name = `${base}@${createHash('sha256').update(provider).digest('hex').slice(0, 12)}`
    if (Object.hasOwn(routes, name) && routes[name].provider === provider) return { files: {}, result: name }
    if (Object.hasOwn(routes, name)) throw new Error('Provider route namespace collision')
    Object.defineProperty(routes, name, { value: { provider }, enumerable: true, configurable: true, writable: true })
    return { files: { [path]: JSON.stringify(routes, null, 2) }, result: name }
  })
  if (!namespace) throw new Error('Unable to allocate provider route')
  return namespace
}

/** Strip only the gateway namespace; an upstream model may contain many slashes. */
export function logicalModelSelection(profile: string, provider: string, model: string): { provider: string; model: string } {
  if (provider !== 'ekkostudio' && provider !== 'custom:ekkostudio') return { provider: canonicalProviderId(profile, provider), model }
  const route = splitModelRoute(model)
  if (!route) throw new Error('Invalid Studio model route')
  const routes: Routes = JSON.parse(readFileSync(join(providerAccountHome(), 'routes.json'), 'utf8'))
  const source = routes[route.namespace]
  if (!source) throw new Error('Studio model route is not available in this account')
  return { provider: canonicalProviderId(profile, source.provider), model: route.model }
}

/** Only bridge metadata containers are traversed; user text/tool payloads stay intact. */
export function logicalHermesMetadata(value: any, fallbackProfile = 'default'): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  let result = value
  const profile = value.profile || fallbackProfile
  if (typeof value.model === 'string' && (['ekkostudio', 'custom:ekkostudio'].includes(value.provider)
    || (value.provider === 'custom' && String(value.base_url || '').includes('/api/ekko-studio/models/')))) {
    const route = splitModelRoute(value.model)
    const routes: Routes = JSON.parse(readFileSync(join(providerAccountHome(), 'routes.json'), 'utf8'))
    const source = route ? routes[route.namespace] : undefined
    if (!source) throw new Error('Unknown Studio model metadata route')
    const logical = logicalModelSelection(profile, 'ekkostudio', value.model)
    result = { ...result, ...logical }
  }
  for (const key of ['events', 'sessions']) if (Array.isArray(value[key])) result = { ...result, [key]: value[key].map((item: any) => logicalHermesMetadata(item, profile)) }
  for (const key of ['config', 'session', 'model_context']) if (value[key] && typeof value[key] === 'object') result = { ...result, [key]: logicalHermesMetadata(value[key], profile) }
  return result
}


/** Preserve previously issued model IDs as aliases after account-pool migration. */
export async function canonicalModelRoute(value: string): Promise<string> {
  const route = splitModelRoute(value)
  if (!route) return value
  let routes: Routes
  try { routes = JSON.parse(readFileSync(join(providerAccountHome(), 'routes.json'), 'utf8')) }
  catch (error: any) { if (error.code === 'ENOENT') return value; throw error }
  const source = routes[route.namespace]
  return source ? qualifyModelRoute(await providerRouteNamespace('', source.provider), route.model) : value
}
