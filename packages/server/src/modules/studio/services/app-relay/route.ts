import { config } from '../../public/config'
import { readAppConfig, writeAppConfig } from '../config/app-config'

export type AppRelayRoute = 'official' | 'cloudflare'

export const DEFAULT_APP_RELAY_ROUTE: AppRelayRoute = 'official'
export const CLOUDFLARE_APP_RELAY_URL = 'https://cn.ekkostudio.xyz'

export function isAppRelayRoute(value: unknown): value is AppRelayRoute {
  return value === 'official' || value === 'cloudflare'
}

export function normalizeAppRelayRoute(value: unknown): AppRelayRoute {
  return isAppRelayRoute(value) ? value : DEFAULT_APP_RELAY_ROUTE
}

export async function getAppRelayRoute(): Promise<AppRelayRoute> {
  return normalizeAppRelayRoute((await readAppConfig()).appRelayRoute)
}

export async function setAppRelayRoute(route: AppRelayRoute): Promise<void> {
  const current = await readAppConfig()
  if (current.appRelayRoute === route) return
  await writeAppConfig({ appRelayRoute: route })
}

export function appRelayUrlForRoute(route: AppRelayRoute): string {
  return route === 'cloudflare' ? CLOUDFLARE_APP_RELAY_URL : config.appRelay.url
}
