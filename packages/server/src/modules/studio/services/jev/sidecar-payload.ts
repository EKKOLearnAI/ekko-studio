import { createHash } from 'node:crypto'
import type { Questions, SystemOneRequest } from '@typesafe-ai/sdk'
import { parseJevRequest } from './client'
import type { JevSidecarReason, TrustedJevRequest } from './sidecar-contract'

export const JEV_SIDECAR_REQUEST_BYTES = 64_000
export const JEV_SIDECAR_QUEUE_INPUT_BYTES = 256 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 20_000

export class JevSidecarInputError extends Error {
  constructor(readonly reason: Extract<JevSidecarReason, 'invalid_input' | 'input_too_large'>) {
    super(reason)
    this.name = 'JevSidecarInputError'
  }
}

function plainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function canonicalValue(value: unknown, depth: number, seen: WeakSet<object>, counter: { value: number }): unknown {
  if (depth > MAX_DEPTH || ++counter.value > MAX_NODES) throw new JevSidecarInputError('invalid_input')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JevSidecarInputError('invalid_input')
    return value
  }
  if (typeof value !== 'object') throw new JevSidecarInputError('invalid_input')
  if (seen.has(value)) throw new JevSidecarInputError('invalid_input')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        if (item === undefined) throw new JevSidecarInputError('invalid_input')
        return canonicalValue(item, depth + 1, seen, counter)
      })
    }
    if (!plainObject(value)) throw new JevSidecarInputError('invalid_input')
    const descriptorMap = Object.getOwnPropertyDescriptors(value)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(descriptorMap).sort()) {
      const descriptor = descriptorMap[key]
      if (!descriptor.enumerable || descriptor.get || descriptor.set || typeof descriptor.value === 'function') {
        throw new JevSidecarInputError('invalid_input')
      }
      if (key === 'toJSON') throw new JevSidecarInputError('invalid_input')
      if (descriptor.value !== undefined) result[key] = canonicalValue(descriptor.value, depth + 1, seen, counter)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function canonicalJevJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, 0, new WeakSet(), { value: 0 }))
}

export function hashJevCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJevJson(value)).digest('hex')
}

export function boundedQueueInput(value: unknown): void {
  const bytes = Buffer.byteLength(canonicalJevJson(value), 'utf8')
  if (bytes > JEV_SIDECAR_QUEUE_INPUT_BYTES) throw new JevSidecarInputError('input_too_large')
}

export function prepareTrustedJevRequest<Q extends Questions>(
  request: TrustedJevRequest<Q>,
  model: string,
): { request: SystemOneRequest<Q>; serialized: string; bytes: number } {
  let parsed: SystemOneRequest<Q>
  try {
    parsed = parseJevRequest({ ...request, model }) as SystemOneRequest<Q>
  } catch {
    throw new JevSidecarInputError('invalid_input')
  }
  const serialized = canonicalJevJson(parsed)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > JEV_SIDECAR_REQUEST_BYTES) throw new JevSidecarInputError('input_too_large')
  return { request: parsed, serialized, bytes }
}
