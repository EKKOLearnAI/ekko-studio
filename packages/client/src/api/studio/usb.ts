import { getApiKey, getBaseUrlValue, request } from '../client'
import type { USBDeviceRecord, USBEventRecord, USBServiceRuntimeStatus } from './usb-socket'

export interface USBFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
}

export interface USBFileStat {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
}

export interface USBDiskUsage {
  totalBytes: number | null
  freeBytes: number | null
  usedBytes: number | null
}

export interface USBReadFileResponse {
  uuid: string
  path: string
  size: number
  encoding: 'utf-8' | 'base64'
  content: string
}

export interface USBDevicesResponse {
  runtime: USBServiceRuntimeStatus
  devices: USBDeviceRecord[]
}

export interface USBHistoryResponse {
  runtime: USBServiceRuntimeStatus
  events: USBEventRecord[]
}

export interface USBListFilesResponse {
  uuid: string
  path: string
  entries: USBFileEntry[]
}

export interface USBCopyToWorkspaceResponse {
  uuid: string
  session_id: string
  workspace: string
  workspacePath: string
  relativeWorkspacePath: string
  size: number
}

function guessMimeType(path: string): string {
  const normalized = path.toLowerCase()
  if (normalized.endsWith('.png')) return 'image/png'
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.gif')) return 'image/gif'
  if (normalized.endsWith('.webp')) return 'image/webp'
  if (normalized.endsWith('.svg')) return 'image/svg+xml'
  if (normalized.endsWith('.json')) return 'application/json'
  if (normalized.endsWith('.md')) return 'text/markdown'
  if (normalized.endsWith('.html')) return 'text/html'
  if (normalized.endsWith('.css')) return 'text/css'
  if (normalized.endsWith('.js')) return 'text/javascript'
  if (normalized.endsWith('.ts')) return 'text/plain'
  return 'text/plain'
}

function decodeBase64ToBytes(content: string): Uint8Array {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function fetchUSBDevices(): Promise<USBDevicesResponse> {
  return request<USBDevicesResponse>('/api/studio/usb/devices')
}

export async function fetchUSBHistory(since = '24h'): Promise<USBHistoryResponse> {
  return request<USBHistoryResponse>(`/api/studio/usb/history?since=${encodeURIComponent(since)}`)
}

export async function listUSBFiles(uuid: string, path = '/'): Promise<USBListFilesResponse> {
  return request<USBListFilesResponse>(`/api/studio/usb/devices/${encodeURIComponent(uuid)}/ls?path=${encodeURIComponent(path)}`)
}

export async function statUSBPath(uuid: string, path = '/'): Promise<{ uuid: string, stat: USBFileStat }> {
  return request<{ uuid: string, stat: USBFileStat }>(`/api/studio/usb/devices/${encodeURIComponent(uuid)}/stat?path=${encodeURIComponent(path)}`)
}

export async function readUSBFile(uuid: string, path: string): Promise<USBReadFileResponse> {
  return request<USBReadFileResponse>(`/api/studio/usb/devices/${encodeURIComponent(uuid)}/read?path=${encodeURIComponent(path)}`)
}

export async function fetchUSBDiskUsage(uuid: string): Promise<{ uuid: string, usage: USBDiskUsage }> {
  return request<{ uuid: string, usage: USBDiskUsage }>(`/api/studio/usb/devices/${encodeURIComponent(uuid)}/disk-usage`)
}

export async function copyUSBFileToWorkspace(
  uuid: string,
  path: string,
  sessionId: string,
  targetPath?: string,
): Promise<USBCopyToWorkspaceResponse> {
  return request<USBCopyToWorkspaceResponse>(`/api/studio/usb/devices/${encodeURIComponent(uuid)}/copy-to-workspace`, {
    method: 'POST',
    body: JSON.stringify({
      path,
      session_id: sessionId,
      ...(targetPath ? { target_path: targetPath } : {}),
    }),
  })
}

export async function fetchUSBFileBlob(uuid: string, path: string): Promise<Blob> {
  const file = await readUSBFile(uuid, path)
  const mimeType = guessMimeType(path)
  if (file.encoding === 'base64') {
    const bytes = decodeBase64ToBytes(file.content)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return new Blob([copy], { type: mimeType })
  }
  return new Blob([file.content], { type: `${mimeType};charset=utf-8` })
}

export async function downloadUSBFile(uuid: string, path: string, fileName?: string): Promise<void> {
  const blob = await fetchUSBFileBlob(uuid, path)
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = fileName || path.split('/').pop() || 'download'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(blobUrl)
}

export function getUSBReadUrl(uuid: string, path: string): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path })
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/studio/usb/devices/${encodeURIComponent(uuid)}/read?${params.toString()}`
}
