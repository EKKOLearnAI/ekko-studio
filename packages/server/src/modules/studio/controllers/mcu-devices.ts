import type { Context } from 'koa'
import { config } from '../public/config'
import { getLanEndpointKind } from '../services/network/lan-discovery'
import { getPublicSystemInfo } from '../public/system-info'
import {
  getGlobalAgentServer,
  getOutboundRelayClient,
  startOutboundRelayClient,
  stopOutboundRelayClient,
} from '../public/global-agent'
import { createMcuDevice, deleteMcuDevice, getMcuDevice, listMcuDevices, updateMcuDeviceName, type McuDeviceRecord } from '../services/devices/mcu-devices'

export async function mcuBackendInfoController(ctx: Context) {
  ctx.set('Access-Control-Allow-Origin', '*')
  ctx.body = {
    ...await getPublicSystemInfo(),
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    relay_url: config.remoteRelay.url,
    app_relay: { protocol: 'socket.io', namespace: '/app-relay', direct: true },
  }
}

function normalizeDeviceCode(value: unknown): string {
  const normalized = String(value || '').trim()
  return normalized.length <= 255 ? normalized : ''
}

function normalizeName(value: unknown, deviceCode: string): string {
  const normalized = String(value || '').trim()
  if (normalized.length > 80) return normalized.slice(0, 80)
  return normalized || deviceCode
}

async function verifyOfficialDeviceCode(deviceCode: string): Promise<boolean> {
  try {
    const url = `${config.remoteRelay.url.replace(/\/$/, '')}/global-agent/device/${encodeURIComponent(deviceCode)}`
    const response = await fetch(url, { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}

function remoteConnectionId(deviceCode: string): string {
  return `mcu-device:${deviceCode}`
}

function requestToken(ctx: Context): string {
  const auth = ctx.headers.authorization || ''
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return typeof ctx.query.token === 'string' ? ctx.query.token.trim() : ''
}

function requestBaseUrl(ctx: Context): string | undefined {
  const host = ctx.get('host').trim()
  if (!host) return undefined
  return `${ctx.protocol || 'http'}://${host}`
}

function localBaseUrl(): string {
  return `http://127.0.0.1:${config.port}`
}

async function localRelayMachineInfo(url: string) {
  const info = await getPublicSystemInfo()
  return {
    ...info,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    url,
    relay_url: config.remoteRelay.url,
  }
}

function withMcuDeviceStatus(device: McuDeviceRecord) {
  const remoteClient = getOutboundRelayClient(remoteConnectionId(device.device_code))
  return {
    ...device,
    lan_connected: Boolean(getGlobalAgentServer()?.hasMcuDeviceCode(device.device_code)),
    remote_connected: Boolean(remoteClient?.isConnected()),
  }
}

function listMcuDevicesWithStatus() {
  return listMcuDevices().map(withMcuDeviceStatus)
}

export async function listMcuDevicesController(ctx: Context) {
  ctx.body = { devices: listMcuDevicesWithStatus() }
}

export async function createMcuDeviceController(ctx: Context) {
  const body = ctx.request.body as { name?: unknown; device_code?: unknown; deviceCode?: unknown } | undefined
  const deviceCode = normalizeDeviceCode(body?.device_code ?? body?.deviceCode)
  if (!deviceCode) {
    ctx.status = 400
    ctx.body = { error: 'device_code is required' }
    return
  }

  const isOfficial = await verifyOfficialDeviceCode(deviceCode)

  try {
    const device = createMcuDevice({
      name: normalizeName(body?.name, deviceCode),
      deviceCode,
      isOfficial,
    })
    ctx.status = 201
    ctx.body = {
      device: withMcuDeviceStatus(device),
      devices: listMcuDevicesWithStatus(),
    }
  } catch (error: any) {
    if (error?.message === 'mcu_device_exists') {
      ctx.status = 409
      ctx.body = { error: 'MCU device already exists' }
      return
    }
    throw error
  }
}

export async function updateMcuDeviceController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const body = ctx.request.body as { name?: unknown } | undefined
  try {
    const device = updateMcuDeviceName(id, String(body?.name || ''))
    ctx.body = {
      device: withMcuDeviceStatus(device),
      devices: listMcuDevicesWithStatus(),
    }
  } catch (error: any) {
    if (error?.message === 'mcu_device_not_found') {
      ctx.status = 404
      ctx.body = { error: 'MCU device not found' }
      return
    }
    throw error
  }
}

export async function deleteMcuDeviceController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const deleted = deleteMcuDevice(id)
  if (!deleted) {
    ctx.status = 404
    ctx.body = { error: 'MCU device not found' }
    return
  }

  ctx.body = { devices: listMcuDevicesWithStatus() }
}

export async function connectMcuDeviceRemoteController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const device = getMcuDevice(id)
  if (!device) {
    ctx.status = 404
    ctx.body = { error: 'MCU device not found' }
    return
  }

  if (!await verifyOfficialDeviceCode(device.device_code)) {
    ctx.status = 403
    ctx.body = { error: '非官方设备码' }
    return
  }

  const userToken = requestToken(ctx)
  if (!userToken) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const connectionId = remoteConnectionId(device.device_code)
  stopOutboundRelayClient(connectionId)
  const baseUrl = localBaseUrl()
  const publicBaseUrl = requestBaseUrl(ctx) || baseUrl
  const machineInfo = await localRelayMachineInfo(publicBaseUrl)
  const client = startOutboundRelayClient({
    connectionId,
    relayUrl: config.remoteRelay.url,
    userToken,
    instanceId: connectionId,
    deviceCode: device.device_code,
    localBaseUrl: baseUrl,
    machineInfo,
    relayProtocol: 'mcu-socket.io',
  })
  if (!client) {
    ctx.status = 400
    ctx.body = { error: 'Failed to start relay client' }
    return
  }
  if (!await client.waitForConnected(8000)) {
    stopOutboundRelayClient(connectionId)
    ctx.status = 502
    ctx.body = { error: 'Failed to connect remote relay' }
    return
  }

  ctx.body = {
    device: withMcuDeviceStatus(device),
    devices: listMcuDevicesWithStatus(),
  }
}

export async function disconnectMcuDeviceRemoteController(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'invalid mcu device id' }
    return
  }

  const device = getMcuDevice(id)
  if (!device) {
    ctx.status = 404
    ctx.body = { error: 'MCU device not found' }
    return
  }

  stopOutboundRelayClient(remoteConnectionId(device.device_code))
  ctx.body = {
    device: withMcuDeviceStatus(device),
    devices: listMcuDevicesWithStatus(),
  }
}
