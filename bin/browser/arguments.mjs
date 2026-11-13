// Validate against the published browser schema before acquiring a tab or dispatching any action.
function validate(schema, value, path) {
  if (schema.oneOf) {
    const variant = schema.oneOf.find(item => item.properties?.action?.const === value?.action)
    return variant ? validate(variant, value, path) : `${path}.action must be click, double_click, right_click, type, hover, select, drag, press, scroll, click_at or drag_at (use "action", not "type")`
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

const isRef = value => typeof value === 'string' && /^@e[1-9]\d*$/.test(value) && value.length <= 32

export function validateBrowserArguments(tool, args) {
  const error = validate(tool.inputSchema, args, 'arguments')
  if (error) return error
  if (tool.name.endsWith('_snapshot')) {
    for (const key of ['offset', 'limit']) if (args[key] !== undefined && !Number.isSafeInteger(args[key])) return `arguments.${key} must be an integer`
    if (args.snapshot_id && ['selector', 'query', 'interactive_only'].some(key => args[key] !== undefined)) {
      return 'arguments.snapshot_id cannot be combined with selector/query/interactive_only; omit it for a new search'
    }
  }
  if (tool.name.endsWith('_interact') || tool.name.endsWith('_batch')) {
    const actions = tool.name.endsWith('_batch') ? args.actions : [args]
    for (const [index, action] of actions.entries()) {
      const path = tool.name.endsWith('_batch') ? `arguments.actions[${index}]` : 'arguments'
      if (['click', 'double_click', 'right_click', 'type', 'hover', 'select', 'drag'].includes(action.action)) {
        if (typeof args.snapshot_id !== 'string' || !args.snapshot_id.trim()) return `arguments.snapshot_id is required for ${action.action}; use the latest snapshotId`
        if (!isRef(action.ref)) return `${path}.ref must be a snapshot ref such as @e1`
      }
      if (action.action === 'drag' && !isRef(action.target_ref)) return `${path}.target_ref must be a snapshot ref such as @e2`
      if (['click_at', 'drag_at'].includes(action.action) && (typeof action.x !== 'number' || typeof action.y !== 'number')) return `${path}.x and ${path}.y are required for ${action.action}`
      if (action.action === 'drag_at' && (typeof action.to_x !== 'number' || typeof action.to_y !== 'number')) return `${path}.to_x and ${path}.to_y are required for drag_at`
      if (action.action === 'type' && typeof action.text !== 'string') return `${path}.text is required for type`
      if (action.action === 'select' && typeof action.value !== 'string') return `${path}.value is required for select`
      if (action.action === 'press' && (typeof action.key !== 'string' || !action.key.trim())) return `${path}.key is required for press`
      if (action.action === 'scroll' && !['up', 'down', 'left', 'right'].includes(action.direction)) return `${path}.direction is required for scroll`
    }
  }
  if (tool.name.endsWith('_upload')) {
    if (args.ref !== undefined && !isRef(args.ref)) return 'arguments.ref must be a snapshot ref such as @e1'
    if (args.ref !== undefined && (typeof args.snapshot_id !== 'string' || !args.snapshot_id.trim())) return 'arguments.snapshot_id is required with ref'
    for (const [index, file] of args.files.entries()) {
      if (!file.path && !(file.name && typeof file.data_base64 === 'string' && file.data_base64)) return `arguments.files[${index}] needs path, or name and data_base64`
      if (file.path && file.data_base64 !== undefined) return `arguments.files[${index}] cannot combine path with data_base64`
    }
  }
  if (tool.name.endsWith('_download') && !args.url === !(args.snapshot_id || args.ref)) {
    return 'arguments must include either url, or snapshot_id and ref'
  }
  if (tool.name.endsWith('_download') && !args.url && !(args.snapshot_id && args.ref)) return 'arguments.snapshot_id and arguments.ref are both required without url'
  if (tool.name.endsWith('_wait') && args.text === undefined && args.text_gone === undefined && args.timeout_ms === undefined) {
    return 'arguments must include text, text_gone or timeout_ms'
  }
}
