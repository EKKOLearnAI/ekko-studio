import { randomBytes, timingSafeEqual } from 'crypto'

const PAIRING_CODE = randomBytes(16).toString('base64url')

export function getDevicePairingCode(): string {
  return PAIRING_CODE
}

export function verifyDevicePairingCode(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const candidate = value.trim()
  if (!candidate) return false

  const expected = Buffer.from(PAIRING_CODE)
  const actual = Buffer.from(candidate)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
