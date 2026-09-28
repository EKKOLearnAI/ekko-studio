// Validate against the published browser schema before acquiring a tab or dispatching any action.
function validate(schema, value, path) {
  if (schema.oneOf) {
    const variant = schema.oneOf.find(item => item.properties?.action?.const === value?.action)
    return variant ? validate(variant, value, path) : `${path}.action must be click, type, press or scroll (use "action", not "type")`
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`
    for (const key of schema.required || []) if (value[key] === undefined) return `${path}.${key} is required`
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false) return `${path}.${key} is not supported`
      } else {
        const error = validate(schema.properties[key], item, `${path}.${key}`)
        if (error) return error
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) {
      return `${path} must contain ${schema.minItems || 0}-${schema.maxItems ?? 'unlimited'} items`
    }
    for (let i = 0; i < value.length; i++) {
      const error = validate(schema.items, value[i], `${path}[${i}]`)
      if (error) return error
    }
  } else if (schema.type && typeof value !== schema.type) return `${path} must be ${schema.type}`
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`
  if (schema.const !== undefined && value !== schema.const) return `${path} must be ${schema.const}`
  if (typeof value === 'string' && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity))) return `${path} has an invalid length`
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return `${path} is out of range`
}

export function validateBrowserArguments(tool, args) {
  const error = validate(tool.inputSchema, args, 'arguments')
  if (error) return error
  if (tool.name.endsWith('_interact') || tool.name.endsWith('_batch')) {
    const actions = tool.name.endsWith('_batch') ? args.actions : [args]
    for (const [index, action] of actions.entries()) {
      const path = tool.name.endsWith('_batch') ? `arguments.actions[${index}]` : 'arguments'
      if (['click', 'type'].includes(action.action)) {
        if (typeof args.snapshot_id !== 'string' || !args.snapshot_id.trim()) return 'arguments.snapshot_id is required for click/type; use the latest snapshotId'
        if (typeof action.ref !== 'string' || !/^@e[1-9]\d*$/.test(action.ref) || action.ref.length > 32) return `${path}.ref must be a snapshot ref such as @e1`
      }
      if (action.action === 'type' && typeof action.text !== 'string') return `${path}.text is required for type`
      if (action.action === 'press' && (typeof action.key !== 'string' || !action.key.trim())) return `${path}.key is required for press`
      if (action.action === 'scroll' && !['up', 'down', 'left', 'right'].includes(action.direction)) return `${path}.direction is required for scroll`
    }
  }
}
