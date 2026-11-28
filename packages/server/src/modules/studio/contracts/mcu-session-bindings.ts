import type { McuAgentRuntime } from '../public/mcu-voice'

export interface McuBindingOwner { userId: number; profile: string; deviceCode: string }
export type McuBindingKind = 'chat' | 'bot'
export interface McuSessionBinding { sessionId: string; kind: McuBindingKind; revision: number }
export interface OwnedMcuDevice {
  deviceCode: string
  clientId: string
  profile: string
  agentRuntime: McuAgentRuntime
  online: true
}
export interface McuBindingSnapshot {
  capabilities: { version: 1; manualApprovals: true; clarificationWait: true }
  device: { deviceCode: string; clientId: string; profile: string; agentRuntime: string; online: boolean }
  binding: McuSessionBinding | null
  revision: number
}

export class McuBindingError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message) }
}

export function mcuDeviceCode(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new McuBindingError('A valid device_code is required', 400, 'mcu_device_code_invalid')
  }
  return value.trim()
}

export function mcuExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new McuBindingError('expected_revision must be a nonnegative safe integer', 400, 'mcu_revision_invalid')
  return value as number
}
