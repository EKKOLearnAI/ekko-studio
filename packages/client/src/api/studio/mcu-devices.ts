import { request } from '../client'

export interface McuDevice {
  id: number
  name: string
  device_code: string
  is_official: boolean
  created_at: number
  lan_connected?: boolean
  remote_connected?: boolean
}

export interface McuDeviceListResponse {
  devices: McuDevice[]
}

export async function fetchMcuDevices(): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>('/api/mcu-devices')
}

export async function createMcuDevice(input: {
  name: string
  device_code: string
}): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>('/api/mcu-devices', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateMcuDeviceName(id: number, name: string): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>(`/api/mcu-devices/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export async function deleteMcuDevice(id: number): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>(`/api/mcu-devices/${encodeURIComponent(String(id))}`, {
    method: 'DELETE',
  })
}

export async function connectMcuDeviceRemote(id: number): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>(`/api/mcu-devices/${encodeURIComponent(String(id))}/remote-connect`, {
    method: 'POST',
  })
}

export async function disconnectMcuDeviceRemote(id: number): Promise<McuDeviceListResponse> {
  return request<McuDeviceListResponse>(`/api/mcu-devices/${encodeURIComponent(String(id))}/remote-disconnect`, {
    method: 'POST',
  })
}
