import { randomUUID } from 'node:crypto'
import { createDeviceSignature, getPublicSystemInfo } from '../../public/system-info'

export function normalizeCloudAgentMachineId(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  if (typeof value !== 'string' || !/^hwui_[A-Za-z0-9_-]{16,64}$/.test(value)) throw new Error('Invalid cloud Agent target machine')
  return value
}

// Re-sign on every reconnect; only the target Studio interprets pairing credentials.
export function groupAgentSocketAuth(auth: Record<string, unknown>, machineId?: string) {
  if (!machineId) return auth
  return (callback: (auth: Record<string, unknown>) => void): void => {
    void (async () => {
      const machine = await getPublicSystemInfo()
      const nonce = randomUUID()
      const timestamp = Date.now()
      const signature = await createDeviceSignature(nonce, timestamp)
      callback({ ...auth, machineId, sourceMachineId: machine.device_id,
        publicKey: machine.device_public_key, nonce, timestamp, signature, machine })
    })().catch(() => callback({ machineId }))
  }
}
