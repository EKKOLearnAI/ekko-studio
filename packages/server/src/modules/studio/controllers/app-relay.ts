import type { Context } from 'koa'
import { getAppRelayClient } from '../services/app-relay/client'
import {
  APP_RELAY_CONNECTION_ID,
  ensureAppRelayHostClient,
  stopAppRelayHostClient,
} from '../services/app-relay/connection'
import { getAppRelayDeviceIdentity } from '../public/system-info'
import {
  appRelayUrlForRoute,
  getAppRelayRoute,
  isAppRelayRoute,
} from '../services/app-relay/route'

function appRelayResponse(relay: Record<string, unknown>) {
  return { relay }
}

export async function getAppRelayStatusController(ctx: Context) {
  const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  const route = await getAppRelayRoute()
  ctx.body = appRelayResponse(
    {
      ...(client?.status() || {
        connected: false,
        machineId: (await getAppRelayDeviceIdentity()).device_id,
        pairingCode: '',
        pairingExpiresAt: 0,
      }),
      route,
      relayUrl: appRelayUrlForRoute(route),
    },
  )
}

export async function connectAppRelayController(ctx: Context) {
  const requestedRoute = (ctx.request?.body as Record<string, unknown> | undefined)?.route
  if (requestedRoute != null && !isAppRelayRoute(requestedRoute)) {
    ctx.status = 400
    ctx.body = { error: 'invalid_app_relay_route' }
    return
  }
  const client = await ensureAppRelayHostClient(isAppRelayRoute(requestedRoute) ? requestedRoute : undefined)
  if (!client || !await client.waitForConnected(8000)) {
    ctx.status = 502
    ctx.body = { error: 'Failed to connect App relay' }
    return
  }

  const pairing = await client.requestPairingCode(8000)
  const route = await getAppRelayRoute()
  ctx.body = appRelayResponse({ ...client.status(), ...pairing, route, relayUrl: appRelayUrlForRoute(route) })
}

export async function updateAppRelayRouteController(ctx: Context) {
  const requestedRoute = (ctx.request?.body as Record<string, unknown> | undefined)?.route
  if (!isAppRelayRoute(requestedRoute)) {
    ctx.status = 400
    ctx.body = { error: 'invalid_app_relay_route' }
    return
  }
  const client = await ensureAppRelayHostClient(requestedRoute)
  if (!client || !await client.waitForConnected(8000)) {
    ctx.status = 502
    ctx.body = { error: 'app_relay_unavailable' }
    return
  }
  ctx.body = appRelayResponse({
    ...client.status(),
    route: requestedRoute,
    relayUrl: appRelayUrlForRoute(requestedRoute),
  })
}

export async function refreshAppRelayPairingController(ctx: Context) {
  const client = getAppRelayClient(APP_RELAY_CONNECTION_ID)
  if (!client?.isConnected()) {
    ctx.status = 409
    ctx.body = { error: 'App relay is not connected' }
    return
  }
  const pairing = await client.requestPairingCode(8000)
  ctx.body = appRelayResponse({ ...client.status(), ...pairing })
}

export async function disconnectAppRelayController(ctx: Context) {
  stopAppRelayHostClient()
  const route = await getAppRelayRoute()
  ctx.body = appRelayResponse({
    connected: false,
    machineId: (await getAppRelayDeviceIdentity()).device_id,
    pairingCode: '',
    pairingExpiresAt: 0,
    route,
    relayUrl: appRelayUrlForRoute(route),
  })
}
