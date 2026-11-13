/** A deliberately small, documented JSON contract dialect. No code is evaluated. */
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const keywords = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'])
const reserved = new Set(['__proto__', 'prototype', 'constructor'])
export function assertSchema(schema, path = 'schema', depth = 0) {
  if (depth > 32 || !schema || typeof schema !== 'object' || Array.isArray(schema) || !types.has(schema.type)) throw new Error(`${path}: invalid schema`)
  if (typeof schema.description !== 'string' || !schema.description.trim()) throw new Error(`${path}: every structure and field needs a description`)
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`${path}: unsupported keyword ${key}`)
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || typeof schema.additionalProperties !== 'boolean' || !Array.isArray(schema.required)) throw new Error(`${path}: declare properties, required and additionalProperties explicitly`)
    for (const [key, value] of Object.entries(schema.properties)) {
      if (reserved.has(key)) throw new Error(`${path}: reserved field ${key}`)
      assertSchema(value, `${path}.${key}`, depth + 1)
    }
    if (schema.required.some(key => !Object.hasOwn(schema.properties, key))) throw new Error(`${path}: required field has no definition`)
  } else if (schema.properties || schema.required || schema.additionalProperties !== undefined) throw new Error(`${path}: object keywords require object type`)
  if (schema.type === 'array') assertSchema(schema.items, `${path}[]`, depth + 1)
  else if (schema.items) throw new Error(`${path}: items requires array type`)
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems']) {
    if (schema[key] === undefined) continue
    const numeric = ['minimum', 'maximum'].includes(key)
    if (!Number.isFinite(schema[key]) || !numeric && (!Number.isInteger(schema[key]) || schema[key] < 0)) throw new Error(`${path}: invalid ${key}`)
    if (numeric && !['number', 'integer'].includes(schema.type) || key.endsWith('Length') && schema.type !== 'string' || key === 'maxItems' && schema.type !== 'array') throw new Error(`${path}: ${key} does not apply to ${schema.type}`)
  }
  if (schema.minimum > schema.maximum || schema.minLength > schema.maxLength) throw new Error(`${path}: inverted limits`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error(`${path}: enum must contain values`)
  for (const value of schema.enum || []) assertValue({ ...schema, enum: undefined }, value, `${path}.enum`)
}
export function assertValue(schema, value, path = 'value', depth = 0) {
  if (depth > 32) throw new Error(`${path}: nesting limit exceeded`)
  const fail = reason => { throw new Error(`${path}: ${reason}`) }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('not in enum')
  switch (schema.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('expected object')
      for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`)
      for (const [key, item] of Object.entries(value)) {
        if (reserved.has(key)) fail(`reserved property ${key}`)
        if (Object.hasOwn(schema.properties, key)) assertValue(schema.properties[key], item, `${path}.${key}`, depth + 1)
        else if (!schema.additionalProperties) fail(`unknown property ${key}`)
        else assertJson(item, `${path}.${key}`, depth + 1)
      }
      break
    case 'array':
      if (!Array.isArray(value)) fail('expected array')
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items')
      value.forEach((item, i) => assertValue(schema.items, item, `${path}[${i}]`, depth + 1)); break
    case 'string':
      if (typeof value !== 'string') fail('expected string')
      if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) fail('invalid length')
      break
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) fail(`expected ${schema.type}`)
      if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) fail('outside range')
      break
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean'); break
    case 'null': if (value !== null) fail('expected null'); break
    default: fail('unsupported type')
  }
  return value
}
function assertJson(value, path, depth) {
  if (depth > 32) throw new Error(`${path}: nesting limit exceeded`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach((item, i) => assertJson(item, `${path}[${i}]`, depth + 1)); return }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) { if (reserved.has(key)) throw new Error(`${path}: reserved field`); assertJson(item, `${path}.${key}`, depth + 1) }
    return
  }
  throw new Error(`${path}: expected JSON data`)
}
export function assertContracts(contract) {
  if (contract.schemaVersion !== 1 || !contract.description?.trim()) throw new Error('Contract needs schemaVersion 1 and a description')
  const sections = ['models', 'rpc', 'tools', 'commands', 'actions', 'events', 'storage', 'checkpoints']
  for (const key of Object.keys(contract)) if (!['schemaVersion', 'description', ...sections].includes(key)) throw new Error(`Unknown contract section ${key}`)
  for (const section of sections) if (!contract[section] || typeof contract[section] !== 'object' || Array.isArray(contract[section])) throw new Error(`Declare ${section}, using {} when unused`)
  for (const [name, schema] of Object.entries(contract.models)) assertSchema(schema, `models.${name}`)
  for (const section of sections.slice(1)) for (const [name, entry] of Object.entries(contract[section])) {
    if (!entry.description?.trim()) throw new Error(`${section}.${name}: description required`)
    const fields = ['rpc', 'tools', 'commands', 'actions'].includes(section) ? ['input', 'output'] : ['model']
    for (const key of fields) if (typeof entry[key] !== 'string' || !Object.hasOwn(contract.models, entry[key])) throw new Error(`${section}.${name}.${key}: unknown model`)
    if (['storage', 'checkpoints'].includes(section) && (!Number.isSafeInteger(entry.version) || entry.version < 1 || !entry.scope?.trim())) throw new Error(`${section}.${name}: positive version and scope required`)
    if (section === 'events' && !['caller', 'plugin'].includes(entry.audience)) throw new Error(`${section}.${name}: declare audience`)
    const allowed = ['description', ...fields, ...(['storage', 'checkpoints'].includes(section) ? ['version', 'scope'] : section === 'events' ? ['audience'] : [])]
    for (const key of Object.keys(entry)) if (!allowed.includes(key)) throw new Error(`${section}.${name}: unknown property ${key}`)
  }
  return contract
}
export function validateModel(contract, name, value) {
  if (!Object.hasOwn(contract.models, name)) throw new Error(`Unknown model ${name}`)
  return assertValue(contract.models[name], value, name)
}
export function registerRpc(ctx, contract, name, handler) {
  const definition = Object.hasOwn(contract.rpc, name) ? contract.rpc[name] : undefined
  if (!definition) throw new Error(`RPC ${name} must be declared in contracts/plugin.json`)
  return ctx.extensions.rpc.register(name, async (input, run) => {
    validateModel(contract, definition.input, input)
    return validateModel(contract, definition.output, await handler(input, run))
  })
}
