import { request } from '@/api/client'

export interface LegacyWindowsDataMigrationDecision {
  schema: 1
  action: 'migrate' | 'decline'
  state: 'completed' | 'failed' | 'pending'
  sourceDirectory: string
  targetDirectory: string
  decidedAt: string
  completedAt?: string
  failedAt?: string
  error?: string
}

export interface LegacyWindowsDataMigrationStatus {
  supported: boolean
  shouldPrompt: boolean
  sourceDirectory: string
  targetDirectory: string
  markerPath: string
  decision: LegacyWindowsDataMigrationDecision | null
}

const ENDPOINT = '/api/hermes/data-migrations/windows-appdata'

export async function fetchLegacyWindowsDataMigrationStatus(): Promise<LegacyWindowsDataMigrationStatus> {
  return request<LegacyWindowsDataMigrationStatus>(ENDPOINT)
}

export async function decideLegacyWindowsDataMigration(
  action: 'migrate' | 'decline',
): Promise<LegacyWindowsDataMigrationStatus> {
  return request<LegacyWindowsDataMigrationStatus>(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}
