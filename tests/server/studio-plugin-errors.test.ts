import { expect, it } from 'vitest'
import { serializeStudioError, StudioError } from '../../packages/studio-plugin-sdk/src'

it('preserves public errors from a separately bundled SDK class', () => {
  class SeparateStudioError extends Error {
    name = 'StudioError'
    code = 'INVALID_ARGUMENT'
    retryable = false
  }
  expect(serializeStudioError(new SeparateStudioError('Invalid working directory'), 'fallback')).toEqual({
    code: 'INVALID_ARGUMENT', message: 'Invalid working directory', retryable: false,
  })
  expect(serializeStudioError(new StudioError('RESOURCE_EXHAUSTED', 'Busy', true), 'fallback')).toEqual({
    code: 'RESOURCE_EXHAUSTED', message: 'Busy', retryable: true,
  })
})

it('redacts ordinary errors, unrecognized codes and oversized error messages', () => {
  for (const error of [new Error('private path'), { name: 'StudioError', code: 'PRIVATE', message: 'secret', retryable: false },
    new StudioError('INTERNAL', 'x'.repeat(4097)), new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private') } })]) {
    expect(serializeStudioError(error, 'Operation failed')).toEqual({ code: 'INTERNAL', message: 'Operation failed', retryable: false })
  }
})

it('never invokes a foreign error getter or serializer', () => {
  const error = { name: 'StudioError', code: 'FORBIDDEN', retryable: false,
    get message(): string { throw new Error('getter must not run') },
    toJSON() { throw new Error('serializer must not run') },
  }
  expect(serializeStudioError(error, 'Operation failed').code).toBe('INTERNAL')
})
