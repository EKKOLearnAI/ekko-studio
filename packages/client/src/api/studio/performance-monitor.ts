import { request } from '../client'

export interface ProcessUsage {
  pid: number
  role: 'web' | 'broker' | 'worker'
  profile?: string
  running: boolean
  cpuPercent: number
  memoryRssBytes: number
  command?: string
  error?: string
}

export interface PerformanceRuntimeSnapshot {
  timestamp: number
  system: {
    platform: string
    arch: string
    uptimeSeconds: number
    cpuCount: number
    cpuPercent: number
    loadAverage: number[]
    totalMemoryBytes: number
    freeMemoryBytes: number
    usedMemoryBytes: number
    memoryPercent: number
  }
  web: {
    pid: number
    uptimeSeconds: number
    memory: Record<string, number>
    cpuPercent: number
  }
  bridge: {
    endpoint: string
    reachable: boolean
    error?: string
    broker: {
      running: boolean
      ready: boolean
      pid?: number
      process?: ProcessUsage
      restartScheduled: boolean
      restartAttempts: number
    }
    workers: Array<ProcessUsage & {
      endpoint?: string
      lastUsedAt?: number
      sessionCount: number
      runningSessionCount: number
    }>
    totalWorkerMemoryRssBytes: number
  }
  sessions: {
    active: number
    running: number
    byProfile: Record<string, number>
  }
}

export async function fetchPerformanceRuntime(): Promise<PerformanceRuntimeSnapshot> {
  return request<PerformanceRuntimeSnapshot>('/api/studio/performance/runtime')
}
