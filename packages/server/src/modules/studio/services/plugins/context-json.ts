import type { Json } from '../../contracts/plugins'
import { json } from './schema'

/** Host messages contain optional JS fields; plugin input must be strict wire JSON. */
export function contextJson(value: unknown): Json {
  const copies = new Map<object, object>()
  function copy(value: unknown, depth = 0): unknown {
    if (!value || typeof value !== 'object' || depth > 32) return value
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (!array && prototype !== Object.prototype && prototype !== null) return value
    if (copies.has(value)) return copies.get(value)
    const result = array ? [] : Object.create(prototype)
    copies.set(value, result)
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key)!
      // Only optional object data fields may disappear. Preserve array slots,
      // accessors and other invalid properties so json() still rejects them.
      if (!array && typeof key === 'string' && field.enumerable && 'value' in field && field.value === undefined) continue
      if ('value' in field) field.value = copy(field.value, depth + 1)
      Object.defineProperty(result, key, field)
    }
    return result
  }
  return json(copy(value))
}
