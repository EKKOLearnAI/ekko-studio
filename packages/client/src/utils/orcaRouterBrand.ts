/**
 * OrcaRouter brand constants.
 *
 * The repository ships no external image assets — every provider icon is an
 * inline SVG — so the official classic PNG is referenced here as the canonical
 * source of truth for the asset, and the login modal reuses the official
 * OrcaRouter vector mark inline to respect the asset policy.
 */
export const ORCA_ROUTER_LOGO_URL = 'https://www.orcarouter.ai/orca-logo-classic.png'

export const ORCA_ROUTER_KEY_DASHBOARD_URL = 'https://www.orcarouter.ai/console/token'

export const ORCA_ROUTER_AUTHORIZED_APPS_URL = 'https://www.orcarouter.ai/console/authorized-apps'

export const ORCA_ROUTER_PROVIDER_IDS = ['orcarouter', 'orcarouter-oauth'] as const

export function isOrcaRouterProviderId(value: unknown): boolean {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (ORCA_ROUTER_PROVIDER_IDS as readonly string[]).includes(id)
}
