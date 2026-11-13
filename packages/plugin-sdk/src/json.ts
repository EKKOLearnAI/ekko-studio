/** Strict wire JSON. Inspect before serializing so values cannot silently disappear or change type. */
export function assertJson(value: unknown, path = 'value', ancestors = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error(`${path}: JSON nesting exceeds 32 levels`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object') throw new Error(`${path}: expected JSON data`)
  if (ancestors.has(value)) throw new Error(`${path}: cyclic JSON data`)
  const array = Array.isArray(value)
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path}: expected a plain JSON object`)
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`${path}: symbol keys are not JSON data`)
  ancestors.add(value)
  try {
    const names = Object.getOwnPropertyNames(value)
    const keys = array ? names.filter(key => key !== 'length') : names
    if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) throw new Error(`${path}: arrays must be dense and have no extra fields`)
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key)
      if (!field || !field.enumerable || !('value' in field)) throw new Error(`${path}.${key}: expected a JSON data property`)
      assertJson(field.value, `${path}.${key}`, ancestors, depth + 1)
    }
  } finally { ancestors.delete(value) }
}
