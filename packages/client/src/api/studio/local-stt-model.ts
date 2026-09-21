import { request } from '@/api/client'

export type LocalSttModelDownloadSource = 'cf' | 'github'
export type LocalSttModelJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type LocalSttModelJobStage = 'queued' | 'resolve' | 'download' | 'verify' | 'extract' | 'validate' | 'install' | 'completed' | 'failed'

export interface LocalSttModelDownloadJob {
  id: string
  source: LocalSttModelDownloadSource
  status: LocalSttModelJobStatus
  stage: LocalSttModelJobStage
  error: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  createdAt: string
  updatedAt: string
}

export interface LocalSttModelStatus {
  id: string
  name: string
  languages: string[]
  archiveSize: number
  extractedSize: number
  installed: boolean
  usable: boolean
  validationError: string
  job: LocalSttModelDownloadJob | null
}

export function fetchLocalSttModelStatus(): Promise<LocalSttModelStatus> {
  return request<LocalSttModelStatus>('/api/studio/stt/local-model')
}

export function downloadLocalSttModel(source: LocalSttModelDownloadSource): Promise<{ success: boolean; job: LocalSttModelDownloadJob }> {
  return request<{ success: boolean; job: LocalSttModelDownloadJob }>('/api/studio/stt/local-model/download', {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
}
