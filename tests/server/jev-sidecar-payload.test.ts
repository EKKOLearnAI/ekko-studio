import { describe, expect, it } from 'vitest'
import {
  canonicalJevJson, hashJevCanonical, JevSidecarInputError, prepareTrustedJevRequest,
} from '../../packages/server/src/modules/studio/services/jev/sidecar-payload'

const questions = { route: { type: 'choice' as const, criteria: { a: null, none: null } } }

describe('JEV sidecar payloads', () => {
  it('canonicalizes object keys while preserving ordered arrays and strings', () => {
    expect(canonicalJevJson({ z: [2, 1], a: ' e\u0301 ' })).toBe('{"a":" é ","z":[2,1]}')
    expect(hashJevCanonical({ b: 2, a: 1 })).toBe(hashJevCanonical({ a: 1, b: 2 }))
    expect(hashJevCanonical({ a: [1, 2] })).not.toBe(hashJevCanonical({ a: [2, 1] }))
  })

  it.each([
    () => { const value: any = {}; value.self = value; return value },
    () => ({ value: Number.NaN }),
    () => ({ values: [undefined] }),
    () => Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'executed' }),
    () => ({ toJSON() { return { hidden: true } } }),
  ])('rejects unsafe or non-JSON input without executing it', make => {
    expect(() => canonicalJevJson(make())).toThrowError(JevSidecarInputError)
  })

  it('measures the complete UTF-8 request after freezing the model', () => {
    const prepared = prepareTrustedJevRequest({ state: { text: '中文' }, questions }, 'jev-fixed')
    expect(prepared.bytes).toBe(Buffer.byteLength(prepared.serialized, 'utf8'))
    expect(prepared.request.model).toBe('jev-fixed')
  })

  it('rejects a complete request over 64KB', () => {
    expect(() => prepareTrustedJevRequest({ state: '中'.repeat(22_000), questions }, 'jev-fixed'))
      .toThrowError(expect.objectContaining({ reason: 'input_too_large' }))
  })
})
