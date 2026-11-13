export type USBDeviceStatus = 'mounted' | 'mount_failed' | 'removed'

export interface USBDeviceRecord {
  uuid: string
  deviceNode: string
  mountPoint: string
  fsType: string | null
  label: string | null
  vendor: string | null
  model: string | null
  serial: string | null
  sizeBytes: number | null
  status: USBDeviceStatus
  error: string | null
  ts: string
}

export interface USBMonitorReadyEvent {
  type: 'ready'
  ts: string
  existing_devices: USBMonitorDeviceEvent[]
}

export interface USBMonitorHeartbeatEvent {
  type: 'heartbeat'
  ts: string
  device_count?: number
}

export interface USBMonitorDeviceEvent {
  type: 'device_event'
  action: 'add' | 'remove'
  device_node: string
  uuid?: string | null
  mount_point?: string | null
  fs_type?: string | null
  label?: string | null
  vendor?: string | null
  model?: string | null
  serial?: string | null
  size_bytes?: number | null
  status: USBDeviceStatus | 'error'
  error?: string | null
  ts: string
}

export type USBMonitorMessage =
  | USBMonitorReadyEvent
  | USBMonitorHeartbeatEvent
  | USBMonitorDeviceEvent

export interface USBEventRecord {
  id: string
  uuid: string
  deviceNode: string
  action: 'add' | 'remove'
  mountPoint: string | null
  fsType: string | null
  label: string | null
  status: string
  error: string | null
  ts: number
}

export interface USBFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string
}

export interface USBFileStat extends USBFileEntry {}

export interface USBDiskUsage {
  totalBytes: number | null
  freeBytes: number | null
  usedBytes: number | null
}

export interface USBServiceRuntimeStatus {
  state: 'idle' | 'starting' | 'running' | 'unsupported' | 'error' | 'stopped'
  monitorScriptPath: string
  lastReadyAt: string | null
  lastHeartbeatAt: string | null
  lastError: string | null
}
