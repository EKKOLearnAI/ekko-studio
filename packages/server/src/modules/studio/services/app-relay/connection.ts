import { config } from '../../public/config'
import { getLanEndpointKind } from '../network/lan-discovery'
import {
  createAppRelayDeviceSignature,
  getAppRelayDeviceIdentity,
  getPublicSystemInfo,
} from '../../public/system-info'
import {
  getAppRelayClient,
  startAppRelayClient,
  stopAppRelayClient,
  type AppRelayClient,
} from './client'
import {
  appRelayUrlForRoute,
  getAppRelayRoute,
  setAppRelayRoute,
  type AppRelayRoute,
} from './route'

export const APP_RELAY_CONNECTION_ID = 'app-relay'

export function shouldReplaceExistingAppRelayHost(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.NODE_ENV === 'production'
}

export async function ensureAppRelayHostClient(requestedRoute?: AppRelayRoute): Promise<AppRelayClient | null> {
  const route = requestedRoute || await getAppRelayRoute()
  if (requestedRoute) await setAppRelayRoute(requestedRoute)
  const relayUrl = appRelayUrlForRoute(route)
  const existing = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (existing && existing.usesRelayUrl(relayUrl) && !existing.isPreconnectionExpired()) return existing
  if (existing) stopAppRelayHostClient()
  const [identity, info] = await Promise.all([getAppRelayDeviceIdentity(), getPublicSystemInfo()])
  return startAppRelayClient({
    connectionId: APP_RELAY_CONNECTION_ID,
    relayUrl,
    machineId: identity.device_id,
    publicKey: identity.device_public_key,
    signChallenge: createAppRelayDeviceSignature,
    replaceExistingHost: shouldReplaceExistingAppRelayHost(),
    machineInfo: {
      model_api_cloud: true,
      model_api_cloud_version: 3,
      ...info,
      device_id: identity.device_id,
      http_port: config.port,
      endpoint_kind: getLanEndpointKind(config.port),
    },
    localBaseUrl: `http://127.0.0.1:${config.port}`,
  })
}

export function stopAppRelayHostClient(): void {
  stopAppRelayClient(APP_RELAY_CONNECTION_ID)
}
