import { afterEach, expect, it, vi } from 'vitest'
import { generateClientUuid } from '../../packages/client/src/utils/client-random'

afterEach(() => vi.unstubAllGlobals())

it('uses the native UUID generator when available', () => {
  const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111')
  vi.stubGlobal('crypto', { randomUUID })
  expect(generateClientUuid()).toBe('11111111-1111-4111-8111-111111111111')
  expect(randomUUID).toHaveBeenCalledOnce()
})

it('generates a v4 UUID from cryptographic bytes without the secure-context UUID API', () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index)); return bytes
  })
  vi.stubGlobal('crypto', { getRandomValues })
  expect(generateClientUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  expect(getRandomValues).toHaveBeenCalledOnce()
})

it('fails closed instead of using predictable channel identifiers when strong randomness is missing', () => {
  vi.stubGlobal('crypto', undefined)
  expect(() => generateClientUuid()).toThrow('Secure random number generation is unavailable')
})
