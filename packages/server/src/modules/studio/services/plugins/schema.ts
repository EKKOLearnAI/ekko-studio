import type { Json, PluginManifest, Schema } from '../../contracts/plugins'
import { PluginError } from './errors'

export function identifier(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(value) || value.includes('..') || ['constructor', 'prototype', '__proto__'].includes(value)) throw new PluginError(`Invalid ${label}`)
  return value
}
export function json(value: unknown): Json {
  const encoded = JSON.stringify(value)
  if (!encoded || Buffer.byteLength(encoded) > 2_000_000) throw new PluginError('Plugin value exceeds the JSON size limit')
  return JSON.parse(encoded)
}
export function validateSchema(schema: Schema, depth = 0): void {
  if (depth > 32 || !schema || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) throw new PluginError('Invalid schema')
  if (depth === 0 && schema.type !== 'object') throw new PluginError('Root schema must be an object')
  const allowed = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', 'secret'])
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new PluginError(`Unsupported schema keyword: ${key}`)
  for (const field of Object.values(schema.properties || {})) validateSchema(field, depth + 1)
  if (schema.items) validateSchema(schema.items, depth + 1)
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !schema.properties?.[key]))) throw new PluginError('Required fields must be declared in properties')
}
export function validate(schema: Schema, value: unknown, path = 'input', depth = 0): void {
  if (depth > 32) throw new PluginError(`${path}: schema nesting limit exceeded`)
  const fail = (reason: string): never => { throw new PluginError(`${path}: ${reason}`, 'PLUGIN_SCHEMA') }
  if (!schema || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) fail('unsupported schema type')
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('value is not in enum')
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object')
      const object = value as Record<string, unknown>
      for (const key of schema.required || []) if (!Object.hasOwn(object, key)) fail(`missing ${key}`)
      for (const [key, item] of Object.entries(object)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('reserved property')
        const field = schema.properties?.[key]
        if (field) validate(field, item, `${path}.${key}`, depth + 1)
        else if (schema.additionalProperties === false) fail(`unknown property ${key}`)
      }
      break
    }
    case 'array':
      if (!Array.isArray(value)) fail('expected array')
      if (schema.maxItems !== undefined && (value as unknown[]).length > schema.maxItems) fail('too many items')
      if (schema.items) (value as unknown[]).forEach((item, i) => validate(schema.items!, item, `${path}[${i}]`, depth + 1))
      break
    case 'string':
      if (typeof value !== 'string') fail('expected string')
      if (schema.minLength !== undefined && (value as string).length < schema.minLength) fail('too short')
      if (schema.maxLength !== undefined && (value as string).length > schema.maxLength) fail('too long')
      break
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value)) fail(`expected ${schema.type}`)
      if (schema.minimum !== undefined && (value as number) < schema.minimum) fail('below minimum')
      if (schema.maximum !== undefined && (value as number) > schema.maximum) fail('above maximum')
      break
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean'); break
    case 'null': if (value !== null) fail('expected null'); break
  }
}
export function manifest(value: unknown): PluginManifest {
  const m = json(value) as unknown as PluginManifest
  identifier(m.id, 'plugin id')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 160) throw new PluginError('Plugin name is required')
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(m.version || '')) throw new PluginError('Plugin requires an exact semantic version')
  if (m.apiVersion !== 1) throw new PluginError('Unsupported plugin API version', 'PLUGIN_INCOMPATIBLE', 422)
  if (!m.server && !m.client) throw new PluginError('Plugin requires a server or client entry')
  for (const entry of [m.server, m.client].filter(Boolean)) {
    if (typeof entry !== 'string' || !/^[\w./-]+\.(?:mjs|js)$/.test(entry) || entry.startsWith('/') || entry.split('/').some(part => part === '..')) throw new PluginError('Plugin entries must be relative, compiled JavaScript files')
  }
  const capabilities = ['api.read', 'api.write', 'tools', 'commands', 'events', 'hooks', 'automation', 'ui', 'storage.client']
  if (!Array.isArray(m.capabilities) || m.capabilities.some(item => !capabilities.includes(item))) throw new PluginError('Invalid plugin capabilities')
  if (m.configSchema) validateSchema(m.configSchema)
  const ids = new Set<string>()
  for (const view of m.views || []) {
    identifier(view.id, 'view id')
    if (ids.has(view.id) || !view.title || !['page', 'sidebar', 'settings', 'message'].includes(view.slot)) throw new PluginError('Invalid or duplicate plugin view')
    ids.add(view.id)
    if (!m.client || !m.capabilities.includes('ui')) throw new PluginError('Views require a client entry and ui capability')
  }
  for (const [name, version] of Object.entries(m.dependencies || {})) {
    identifier(name)
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new PluginError('Plugin dependencies require exact versions')
  }
  return m
}
export function configuration(schema: Schema | undefined, input: Record<string, Json>, complete = true): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginError('Plugin configuration must be an object')
  const result = json(input) as Record<string, Json>
  function defaults(value: Json, shape?: Schema): void {
    if (Array.isArray(value)) { for (const item of value) defaults(item, shape?.items); return }
    if (!value || typeof value !== 'object') return
    for (const [key, field] of Object.entries(shape?.properties || {})) {
      if (value[key] === undefined && field.default !== undefined) value[key] = structuredClone(field.default)
      if (value[key] !== undefined) defaults(value[key], field)
    }
  }
  defaults(result, schema)
  if (schema && complete) validate(schema, result, 'config')
  return result
}
