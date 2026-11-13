import {
  DuplicateDeviceRequestError,
  deleteDeviceRelation,
  getDeviceRelation,
  listInboundRequestHistory,
  listDeviceRelations,
  requestInboundDeviceLink,
  updateInboundStatus,
  updateOutboundStatus,
  type DeviceRelationRecord,
  type DeviceInboundStatus,
  type DeviceOutboundStatus,
} from '../services/network/device-relations'
import {
  getLanBackendUrlForRequest,
  getLanDiscoveryCache,
  getLanEndpointKind,
  isPrivateOrLoopbackIPv4,
  scanLanDevices,
  type LanDeviceInfo,
} from '../services/network/lan-pairing-discovery'
import { getLanPeerSocketManager } from '../services/network/lan-peer-socket'
import { getLanPeerToolsService } from '../services/network/lan-peer-tools'
import { getDevicePairingCode, verifyDevicePairingCode } from '../services/network/device-pairing-code'
import { createDeviceSignature, deviceIdFromPublicKey, getPublicSystemInfo, verifyDeviceSignature } from '../public/system-info'
import { describeLanJsonPostError, getLanJson, postLanJson } from '../services/network/lan-http-client'
import { checkPairing, recordPairingFailure } from '../services/auth/login-limiter'
import { config } from '../public/config'
import { randomUUID } from 'crypto'

const REQUEST_TTL_MS = 5 * 60 * 1000
const seenRequestNonces = new Map<string, number>()

type LinkInfoResponse = {
  device_id?: unknown
  device_public_key?: unknown
  computer_name?: unknown
  os?: {
    type?: unknown
    platform?: unknown
    release?: unknown
    arch?: unknown
  }
  hermes_agent_version?: unknown
  hermes_web_ui_version?: unknown
  http_port?: unknown
  endpoint_kind?: unknown
}

function rememberNonce(deviceId: string, nonce: string, timestamp: number): boolean {
  const now = Date.now()
  for (const [key, expiresAt] of seenRequestNonces) {
    if (expiresAt <= now) seenRequestNonces.delete(key)
  }

  const key = `${deviceId}:${nonce}`
  if (seenRequestNonces.has(key)) return false
  seenRequestNonces.set(key, timestamp + REQUEST_TTL_MS)
  return true
}

function parseRemoteStatus(status: unknown): DeviceOutboundStatus | null {
  return status === 'none' ||
    status === 'pending' ||
    status === 'approved' ||
    status === 'rejected' ||
    status === 'blocked'
    ? status
    : null
}

async function fetchRemoteLinkStatus(device: LanDeviceInfo): Promise<DeviceOutboundStatus | null> {
  const timestamp = Date.now()
  const nonce = randomUUID()
  const localInfo = await getPublicSystemInfo()
  const signature = await createDeviceSignature(nonce, timestamp)
  try {
    const response = await postLanJson(`${device.url.replace(/\/$/, '')}/api/devices/link-status`, {
      device_id: localInfo.device_id,
      device_public_key: localInfo.device_public_key,
      timestamp,
      nonce,
      signature,
    }, 1500)
    if (!response.ok) return null
    return parseRemoteStatus(response.data.status)
  } catch {
    return null
  }
}

async function syncOutboundStatuses(devices: LanDeviceInfo[]): Promise<Map<string, DeviceOutboundStatus>> {
  const statuses = new Map<string, DeviceOutboundStatus>()
  await Promise.all(devices.map(async device => {
    const status = await fetchRemoteLinkStatus(device)
    if (!status) return
    statuses.set(device.id, status)

    const existing = getDeviceRelation(device.id)
    if (status === 'pending') return
    if (status !== 'none' || existing?.outbound_status !== 'none') {
      updateOutboundStatus(device.id, status, device)
    }
  }))
  return statuses
}

function relationToDevice(relation: DeviceRelationRecord): LanDeviceInfo {
  return {
    id: relation.id,
    device_id: relation.device_id,
    device_public_key: relation.device_public_key,
    ip: relation.ip,
    http_port: relation.http_port,
    endpoint_kind: relation.endpoint_kind,
    url: relation.url,
    computer_name: relation.computer_name,
    os: relation.os,
    hermes_agent_version: relation.hermes_agent_version,
    hermes_web_ui_version: relation.hermes_web_ui_version,
    response_ms: relation.response_ms,
    last_seen_at: new Date(relation.last_seen_at || relation.updated_at || Date.now()).toISOString(),
  }
}

function mergeKnownDevices(discoveredDevices: LanDeviceInfo[], relations: DeviceRelationRecord[]): LanDeviceInfo[] {
  const devicesById = new Map(discoveredDevices.map(device => [device.id, device]))
  for (const relation of relations) {
    if (devicesById.has(relation.id)) continue
    if (relation.inbound_status === 'none' && relation.outbound_status === 'none') continue
    if (!relation.device_public_key || !relation.url || !relation.http_port) continue
    devicesById.set(relation.id, relationToDevice(relation))
  }
  return [...devicesById.values()]
}

async function devicesPayload() {
  const cache = getLanDiscoveryCache()
  const knownRelations = listDeviceRelations()
  const discoveredDeviceIds = new Set(cache.devices.map(device => device.id))
  const knownDevices = mergeKnownDevices(cache.devices, knownRelations)
  const remoteStatuses = await syncOutboundStatuses(knownDevices)
  const relations = new Map(listDeviceRelations().map(device => [device.id, device]))
  const devices = knownDevices.map(device => {
    const relation = relations.get(device.id)
    const outboundStatus = remoteStatuses.get(device.id) || relation?.outbound_status || 'none'
    const online = discoveredDeviceIds.has(device.id) || remoteStatuses.has(device.id)
    if (online && outboundStatus === 'approved') {
      void getLanPeerSocketManager().connectToDevice(device).catch(err => {
        console.warn('[lan-peer] failed to connect paired device:', err?.message || err)
      })
    }
    return {
      ...device,
      online,
      inbound_status: relation?.inbound_status || 'none',
      outbound_status: outboundStatus,
      requested_at: relation?.requested_at || 0,
      decided_at: relation?.decided_at || null,
      outbound_requested_at: relation?.outbound_requested_at || 0,
      outbound_decided_at: relation?.outbound_decided_at || null,
      updated_at: relation?.updated_at || 0,
    }
  })

  return {
    scanning: cache.scanning,
    last_scanned_at: cache.last_scanned_at,
    devices,
    requests: listInboundRequestHistory(),
  }
}

export async function listDevices(ctx: any) {
  ctx.body = await devicesPayload()
}

function normalizedManualDeviceUrl(input: unknown): URL | null {
  const raw = String(input || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function pairingCodeFromUrl(url: URL): string {
  const direct = url.searchParams.get('pairing_code') || url.searchParams.get('pairingCode') || url.searchParams.get('code')
  if (direct) return direct.trim()

  const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : ''
  if (!hashQuery) return ''
  const hashParams = new URLSearchParams(hashQuery)
  return (hashParams.get('pairing_code') || hashParams.get('pairingCode') || hashParams.get('code') || '').trim()
}

function manualPairingCode(input: unknown): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  try {
    return pairingCodeFromUrl(new URL(raw.includes('://') ? raw : `http://${raw}`))
  } catch {
    return ''
  }
}

function requestProtocol(ctx: any): string {
  const forwardedProto = typeof ctx.get === 'function' ? ctx.get('x-forwarded-proto') : ''
  const proto = String(forwardedProto || ctx.protocol || 'http').split(',')[0]?.trim().toLowerCase()
  return proto === 'https' ? 'https' : 'http'
}

function requestHost(ctx: any): string {
  return String(ctx.host || (typeof ctx.get === 'function' ? ctx.get('host') : '') || '').trim()
}

function devicePairingOrigin(ctx: any): string {
  const host = requestHost(ctx)
  const requestOrigin = host ? `${requestProtocol(ctx)}://${host}` : ''
  const remoteAddress = String(ctx.req?.socket?.remoteAddress || ctx.ip || ctx.request?.ip || '')
  return getLanBackendUrlForRequest(remoteAddress, requestOrigin, config.port)
}

function responseMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function deviceFromLinkInfo(baseUrl: URL, info: LinkInfoResponse, latencyMs: number): LanDeviceInfo | null {
  const deviceId = typeof info.device_id === 'string' ? info.device_id.trim() : ''
  const publicKey = typeof info.device_public_key === 'string' ? info.device_public_key : ''
  if (!deviceId || !publicKey) return null
  if (deviceIdFromPublicKey(publicKey) !== deviceId) return null
  const httpPort = Number(info.http_port) || Number(baseUrl.port) || (baseUrl.protocol === 'https:' ? 443 : 80)
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null
  const endpointKind = info.endpoint_kind === 'web' || info.endpoint_kind === 'desktop' || info.endpoint_kind === 'custom'
    ? info.endpoint_kind
    : getLanEndpointKind(httpPort)

  return {
    id: deviceId,
    device_id: deviceId,
    device_public_key: publicKey,
    ip: baseUrl.hostname,
    http_port: httpPort,
    endpoint_kind: endpointKind,
    url: baseUrl.origin,
    computer_name: String(info.computer_name || ''),
    os: {
      type: String(info.os?.type || ''),
      platform: String(info.os?.platform || '') as NodeJS.Platform,
      release: String(info.os?.release || ''),
      arch: String(info.os?.arch || ''),
    },
    hermes_agent_version: String(info.hermes_agent_version || ''),
    hermes_web_ui_version: String(info.hermes_web_ui_version || ''),
    response_ms: latencyMs,
    last_seen_at: new Date().toISOString(),
  }
}

async function fetchManualDevice(baseUrl: URL): Promise<LanDeviceInfo> {
  const startedAt = Date.now()
  const response = await getLanJson(`${baseUrl.origin}/api/devices/link-info`, 5000)
  if (!response.ok) {
    throw new Error(`Device info request failed: ${response.status}`)
  }
  const device = deviceFromLinkInfo(baseUrl, response.data as LinkInfoResponse, responseMs(startedAt))
  if (!device) throw new Error('Remote URL did not return valid device info')
  return device
}

async function requestPairingWithDevice(target: LanDeviceInfo, pairingCode = ''): Promise<DeviceOutboundStatus> {
  const timestamp = Date.now()
  const nonce = randomUUID()
  const localInfo = await getPublicSystemInfo()
  const signature = await createDeviceSignature(nonce, timestamp)
  const body = {
    ...localInfo,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    timestamp,
    nonce,
    signature,
    pairing_code: pairingCode,
  }

  const response = await postLanJson(`${target.url.replace(/\/$/, '')}/api/devices/link-request`, body, 5000)
  const data = response.data as { status?: unknown; error?: unknown }
  if (!response.ok) {
    const err = new Error(typeof data.error === 'string' ? data.error : `Request failed: ${response.status}`) as Error & { status?: number }
    err.status = response.status === 409 ? 409 : 502
    throw err
  }
  return parseRemoteStatus(data.status) || 'pending'
}

export async function deviceLinkInfoController(ctx: any) {
  ctx.set('Access-Control-Allow-Origin', '*')
  const info = await getPublicSystemInfo()
  ctx.body = {
    ...info,
    http_port: config.port,
    endpoint_kind: getLanEndpointKind(config.port),
    relay_url: config.remoteRelay.url,
    app_relay: {
      protocol: 'socket.io',
      namespace: '/app-relay',
      direct: true,
    },
  }
}

export async function getDevicePairingLink(ctx: any) {
  const code = getDevicePairingCode()
  const origin = devicePairingOrigin(ctx)
  ctx.body = {
    code,
    link: `${origin}/#/hermes/devices?pairing_code=${encodeURIComponent(code)}`,
  }
}

export async function requestManualDevicePairing(ctx: any) {
  const inputUrl = (ctx.request.body as any)?.url
  const baseUrl = normalizedManualDeviceUrl(inputUrl)
  if (!baseUrl) {
    ctx.status = 400
    ctx.body = { error: 'Invalid device URL' }
    return
  }

  try {
    const target = await fetchManualDevice(baseUrl)
    const remoteStatus = await requestPairingWithDevice(target, manualPairingCode(inputUrl))
    if (remoteStatus !== 'none') updateOutboundStatus(target.id, remoteStatus, target)
    ctx.body = await devicesPayload()
  } catch (err: any) {
    ctx.status = Number(err?.status) || 502
    ctx.body = {
      error: err?.message ? `Failed to request device pairing: ${err.message}` : 'Failed to request device pairing',
      detail: describeLanJsonPostError(err),
    }
  }
}

export async function scanDevices(ctx: any) {
  await scanLanDevices()
  ctx.body = await devicesPayload()
}

function findDiscoveredDevice(id: string): LanDeviceInfo | null {
  const discovered = getLanDiscoveryCache().devices.find(device => device.id === id)
  if (discovered) return discovered
  const relation = getDeviceRelation(id)
  return relation ? relationToDevice(relation) : null
}

function normalizeIp(ctx: any): string {
  const ip = String(ctx.ip || ctx.request?.ip || '')
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function forwardedClientIp(ctx: any): string {
  const header = typeof ctx.get === 'function'
    ? ctx.get('x-forwarded-for')
    : ctx.headers?.['x-forwarded-for'] || ctx.request?.headers?.['x-forwarded-for']
  const value = Array.isArray(header) ? header[0] : String(header || '')
  const first = value.split(',')[0]?.trim() || ''
  return first.startsWith('::ffff:') ? first.slice(7) : first
}

function isPrivateOrLoopbackAddress(ip: string): boolean {
  return ip === '::1' || ip === 'localhost' || isPrivateOrLoopbackIPv4(ip)
}

function requiresPairingCode(ctx: any, device: LanDeviceInfo): boolean {
  const sourceIp = normalizeIp(ctx)
  if (!isPrivateOrLoopbackAddress(sourceIp)) return true
  if (forwardedClientIp(ctx)) return true
  return !isPrivateOrLoopbackAddress(device.ip)
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function bodyToDevice(ctx: any, body: any): LanDeviceInfo | null {
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : ''
  const httpPort = Number(body?.http_port)
  if (!deviceId || !publicKey || !Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) return null
  const ip = normalizeIp(ctx)
  const endpointKind = body.endpoint_kind === 'web' || body.endpoint_kind === 'desktop' || body.endpoint_kind === 'custom'
    ? body.endpoint_kind
    : getLanEndpointKind(httpPort)

  return {
    id: deviceId,
    device_id: deviceId,
    device_public_key: publicKey,
    ip,
    http_port: httpPort,
    endpoint_kind: endpointKind,
    url: `http://${hostForUrl(ip)}:${httpPort}`,
    computer_name: String(body?.computer_name || ''),
    os: {
      type: String(body?.os?.type || ''),
      platform: String(body?.os?.platform || '') as NodeJS.Platform,
      release: String(body?.os?.release || ''),
      arch: String(body?.os?.arch || ''),
    },
    hermes_agent_version: String(body?.hermes_agent_version || ''),
    hermes_web_ui_version: String(body?.hermes_web_ui_version || ''),
    response_ms: 0,
    last_seen_at: new Date().toISOString(),
  }
}

export async function requestDeviceLinkController(ctx: any) {
  const body = ctx.request.body as any
  const timestamp = Number(body?.timestamp)
  const nonce = typeof body?.nonce === 'string' ? body.nonce : ''
  const signature = typeof body?.signature === 'string' ? body.signature : ''
  const device = bodyToDevice(ctx, body)

  if (!device || !Number.isFinite(timestamp) || !nonce || !signature) {
    ctx.status = 400
    ctx.body = { error: 'Invalid device request' }
    return
  }
  if (Math.abs(Date.now() - timestamp) > REQUEST_TTL_MS) {
    ctx.status = 400
    ctx.body = { error: 'Device request expired' }
    return
  }
  if (!verifyDeviceSignature({
    device_id: device.id,
    device_public_key: device.device_public_key,
    nonce,
    timestamp,
    signature,
  })) {
    ctx.status = 401
    ctx.body = { error: 'Invalid device signature' }
    return
  }
  if (!rememberNonce(device.id, nonce, timestamp)) {
    ctx.status = 409
    ctx.body = { error: 'Device request replayed' }
    return
  }
  if (requiresPairingCode(ctx, device)) {
    const pairingIp = normalizeIp(ctx) || 'unknown'
    const lock = checkPairing(pairingIp)
    if (!lock.allowed) {
      ctx.status = lock.status
      ctx.body = { error: 'Too many invalid pairing attempts, please try again later' }
      return
    }
    if (!verifyDevicePairingCode(body?.pairing_code)) {
      recordPairingFailure(pairingIp)
      ctx.status = 403
      ctx.body = { error: 'Invalid pairing code' }
      return
    }
  }

  try {
    const record = requestInboundDeviceLink(device)
    ctx.body = { status: record.inbound_status }
  } catch (err) {
    if (err instanceof DuplicateDeviceRequestError) {
      ctx.status = 409
      ctx.body = { error: 'Duplicate pairing request' }
      return
    }
    throw err
  }
}

export async function requestDeviceLinkStatusController(ctx: any) {
  const body = ctx.request.body as any
  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const publicKey = typeof body?.device_public_key === 'string' ? body.device_public_key : ''
  const timestamp = Number(body?.timestamp)
  const nonce = typeof body?.nonce === 'string' ? body.nonce : ''
  const signature = typeof body?.signature === 'string' ? body.signature : ''

  if (!deviceId || !publicKey || !Number.isFinite(timestamp) || !nonce || !signature) {
    ctx.status = 400
    ctx.body = { error: 'Invalid device status request' }
    return
  }
  if (Math.abs(Date.now() - timestamp) > REQUEST_TTL_MS) {
    ctx.status = 400
    ctx.body = { error: 'Device status request expired' }
    return
  }
  if (!verifyDeviceSignature({
    device_id: deviceId,
    device_public_key: publicKey,
    nonce,
    timestamp,
    signature,
  })) {
    ctx.status = 401
    ctx.body = { error: 'Invalid device signature' }
    return
  }
  if (!rememberNonce(deviceId, nonce, timestamp)) {
    ctx.status = 409
    ctx.body = { error: 'Device status request replayed' }
    return
  }

  ctx.body = {
    status: getDeviceRelation(deviceId)?.inbound_status || 'none',
  }
}

async function transitionInboundDevice(ctx: any, status: DeviceInboundStatus) {
  try {
    updateInboundStatus(ctx.params.id, status, findDiscoveredDevice(ctx.params.id) || undefined)
    ctx.body = await devicesPayload()
  } catch {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
  }
}

export async function approveDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'approved')
}

export async function rejectDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'rejected')
}

export async function blockDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'blocked')
}

export async function unblockDevice(ctx: any) {
  await transitionInboundDevice(ctx, 'none')
}

export async function deleteDeviceRequestHistory(ctx: any) {
  if (!deleteDeviceRelation(ctx.params.id)) {
    ctx.status = 404
    ctx.body = { error: 'Device request not found' }
    return
  }
  getLanPeerSocketManager().disconnectDevice(ctx.params.id)
  ctx.body = await devicesPayload()
}

export async function listPeerConnections(ctx: any) {
  ctx.body = {
    connections: getLanPeerSocketManager().listConnections(),
  }
}

export async function connectPeerDevice(ctx: any) {
  const target = findDiscoveredDevice(ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
    return
  }

  const relation = getDeviceRelation(ctx.params.id)
  if (relation?.outbound_status !== 'approved') {
    ctx.status = 403
    ctx.body = { error: 'Device pairing has not been approved' }
    return
  }

  try {
    const connection = await getLanPeerSocketManager().connectToDevice(target)
    ctx.body = { connection }
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err?.message || 'Failed to connect peer device' }
  }
}

export async function disconnectPeerDevice(ctx: any) {
  if (!getLanPeerSocketManager().disconnect(ctx.params.connectionId)) {
    ctx.status = 404
    ctx.body = { error: 'Peer connection not found' }
    return
  }
  ctx.body = {
    connections: getLanPeerSocketManager().listConnections(),
  }
}

function numberFromBody(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function handlePeerToolError(ctx: any, err: any) {
  ctx.status = Number(err?.status) || 502
  ctx.body = { error: err?.message || 'Peer operation failed' }
}

export async function createPeerTerminal(ctx: any) {
  const body = ctx.request.body as any
  try {
    const terminal = await getLanPeerToolsService().createTerminal(ctx.params.connectionId, {
      shell: typeof body?.shell === 'string' ? body.shell : undefined,
      cols: numberFromBody(body?.cols, 80),
      rows: numberFromBody(body?.rows, 24),
    })
    ctx.body = { terminal }
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function listPeerTerminals(ctx: any) {
  try {
    ctx.body = {
      terminals: getLanPeerToolsService().listTerminals(ctx.params.connectionId),
    }
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function writePeerTerminal(ctx: any) {
  const body = ctx.request.body as any
  try {
    ctx.body = getLanPeerToolsService().writeTerminal({
      connectionId: ctx.params.connectionId,
      terminalId: String(ctx.params.terminalId || ''),
      data: String(body?.data || ''),
    })
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function resizePeerTerminal(ctx: any) {
  const body = ctx.request.body as any
  try {
    ctx.body = getLanPeerToolsService().resizeTerminal({
      connectionId: ctx.params.connectionId,
      terminalId: String(ctx.params.terminalId || ''),
      cols: numberFromBody(body?.cols, 80),
      rows: numberFromBody(body?.rows, 24),
    })
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function readPeerTerminal(ctx: any) {
  try {
    ctx.body = {
      terminal: getLanPeerToolsService().readTerminal({
        connectionId: ctx.params.connectionId,
        terminalId: String(ctx.params.terminalId || ''),
      }),
    }
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function closePeerTerminal(ctx: any) {
  try {
    ctx.body = getLanPeerToolsService().closeTerminal({
      connectionId: ctx.params.connectionId,
      terminalId: String(ctx.params.terminalId || ''),
    })
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function execPeerCommand(ctx: any) {
  const body = ctx.request.body as any
  try {
    const result = await getLanPeerToolsService().exec({
      connectionId: ctx.params.connectionId,
      command: String(body?.command || ''),
      args: Array.isArray(body?.args) ? body.args.map(String) : [],
      cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
      timeoutMs: numberFromBody(body?.timeout_ms, 30000),
    })
    ctx.body = { result }
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function downloadPeerFile(ctx: any) {
  const body = ctx.request.body as any
  try {
    ctx.body = await getLanPeerToolsService().downloadFile({
      connectionId: ctx.params.connectionId,
      remotePath: String(body?.remote_path || body?.path || ''),
      localPath: String(body?.local_path || ''),
      timeoutMs: numberFromBody(body?.timeout_ms, 60000),
    })
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function uploadPeerFile(ctx: any) {
  const body = ctx.request.body as any
  try {
    ctx.body = await getLanPeerToolsService().uploadFile({
      connectionId: ctx.params.connectionId,
      localPath: String(body?.local_path || ''),
      remotePath: String(body?.remote_path || body?.path || ''),
      timeoutMs: numberFromBody(body?.timeout_ms, 60000),
    })
  } catch (err: any) {
    handlePeerToolError(ctx, err)
  }
}

export async function requestDevicePairing(ctx: any) {
  const target = findDiscoveredDevice(ctx.params.id)
  if (!target) {
    ctx.status = 404
    ctx.body = { error: 'Device not found' }
    return
  }

  try {
    const body = ctx.request.body as any
    const remoteStatus = await requestPairingWithDevice(target, typeof body?.pairing_code === 'string' ? body.pairing_code : '')
    if (remoteStatus !== 'none') updateOutboundStatus(target.id, remoteStatus, target)
    ctx.body = await devicesPayload()
  } catch (err: any) {
    const detail = describeLanJsonPostError(err)
    ctx.status = Number(err?.status) || 502
    ctx.body = {
      error: err?.message ? `Failed to request device pairing: ${err.message}` : 'Failed to request device pairing',
      detail,
    }
  }
}
