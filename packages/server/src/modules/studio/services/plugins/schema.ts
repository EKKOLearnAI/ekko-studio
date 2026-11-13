import type { Json, PluginManifest, Schema } from '../../contracts/plugins'
import { PLUGIN_ICON_PATHS, PLUGIN_PERMISSIONS, assertJson } from '../../../../../../plugin-sdk/src'
import { PluginError } from './errors'
import { validateDetails, validateIcon } from './manifest-details'

export function identifier(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(value) || value.includes('..') || ['constructor', 'prototype', '__proto__'].includes(value)) throw new PluginError(`Invalid ${label}`)
  return value
}
export function json(value: unknown): Json {
  try { assertJson(value) } catch (error) { throw new PluginError(error instanceof Error ? error.message : 'Invalid JSON data', 'PLUGIN_SCHEMA') }
  const encoded = JSON.stringify(value)
  if (!encoded || Buffer.byteLength(encoded) > 2_000_000) throw new PluginError('Plugin value exceeds the JSON size limit')
  return JSON.parse(encoded)
}
export function validateSchema(schema: Schema, depth = 0): void {
  if (depth === 0) json(schema)
  if (depth > 32 || !schema || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) throw new PluginError('Invalid schema')
  if (depth === 0 && schema.type !== 'object') throw new PluginError('Root schema must be an object')
  const allowed = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'maxItems', 'secret'])
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new PluginError(`Unsupported schema keyword: ${key}`)
  for (const key of ['title', 'description'] as const) if (schema[key] !== undefined && typeof schema[key] !== 'string') throw new PluginError(`Schema ${key} must be a string`)
  for (const key of ['secret', 'additionalProperties'] as const) if (schema[key] !== undefined && typeof schema[key] !== 'boolean') throw new PluginError(`Schema ${key} must be a boolean`)
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw new PluginError('Schema properties must be an object')
  if (schema.type !== 'object' && (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined)) throw new PluginError('Object schema keywords require object type')
  if (schema.items !== undefined && schema.type !== 'array') throw new PluginError('Schema items requires array type')
  for (const field of Object.values(schema.properties || {})) validateSchema(field, depth + 1)
  if (schema.items) validateSchema(schema.items, depth + 1)
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties || {}, key)))) throw new PluginError('Required fields must be declared in properties')
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'] as const) {
    const value = schema[key]
    if (value === undefined) continue
    const numeric = key === 'minimum' || key === 'maximum'
    if (!Number.isFinite(value) || !numeric && (!Number.isSafeInteger(value) || value < 0)) throw new PluginError(`Invalid schema ${key}`)
    if (numeric && !['number', 'integer'].includes(schema.type) || key.endsWith('Length') && schema.type !== 'string' || key === 'maxItems' && schema.type !== 'array') throw new PluginError(`Schema ${key} does not apply to ${schema.type}`)
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum || schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) throw new PluginError('Schema limits are inverted')
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) throw new PluginError('Schema enum must be a nonempty array')
    for (const value of schema.enum) validate({ ...schema, enum: undefined }, value, 'schema.enum')
  }
  if (schema.default !== undefined) validate(schema, schema.default, 'schema.default')
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('Plugin manifest must be an object')
  const m = json(value) as unknown as PluginManifest
  identifier(m.id, 'plugin id')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 160) throw new PluginError('Plugin name is required')
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(m.version || '')) throw new PluginError('Plugin requires an exact semantic version')
  if ('capabilities' in m) throw new PluginError('SDK v1 uses permissions, not capabilities', 'PLUGIN_INCOMPATIBLE', 422)
  if (m.apiVersion !== 1) throw new PluginError('Unsupported plugin API version', 'PLUGIN_INCOMPATIBLE', 422)
  validateDetails(m)
  if (!m.server && !m.client) throw new PluginError('Plugin requires a server or client entry')
  for (const entry of [m.server, m.client].filter(Boolean)) {
    if (typeof entry !== 'string' || !/^[\w./-]+\.(?:mjs|js)$/.test(entry) || entry.startsWith('/') || entry.split('/').some(part => part === '..')) throw new PluginError('Plugin entries must be relative, compiled JavaScript files')
  }
  if (!Array.isArray(m.permissions) || m.permissions.some(item => !(PLUGIN_PERMISSIONS as readonly string[]).includes(item))) throw new PluginError('Invalid plugin permissions')
  if (m.mcp !== undefined) {
    if (!m.mcp || typeof m.mcp !== 'object' || Array.isArray(m.mcp) || Object.keys(m.mcp).some(key => key !== 'name')
      || typeof m.mcp.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(m.mcp.name)
      || ['constructor', 'prototype', '__proto__'].includes(m.mcp.name)) throw new PluginError('Plugin MCP name must start with a lowercase letter and contain up to 64 lowercase letters, digits, underscores or hyphens')
    if (m.mcp.name !== 'ekko-studio-plugins' && /^(?:(?:ekko|hermes)-studio(?:-|$)|hermes-web-ui(?:-|$))/.test(m.mcp.name)) throw new PluginError('Plugin MCP name is reserved by Studio')
    if (!m.permissions.includes('tools')) throw new PluginError('Plugin MCP configuration requires the tools capability')
  }
  if (m.configSchema) validateSchema(m.configSchema)
  const ids = new Set<string>()
  if (m.views !== undefined && (!Array.isArray(m.views) || m.views.length > 50)) throw new PluginError('Invalid plugin views')
  for (const view of m.views || []) {
    if (!view || typeof view !== 'object') throw new PluginError('Invalid plugin view')
    identifier(view.id, 'view id')
    if (ids.has(view.id) || typeof view.title !== 'string' || !view.title.trim() || view.title.length > 160 || !['page', 'workspace', 'settings', 'agent-settings'].includes(view.slot)) throw new PluginError('Invalid or duplicate plugin view; use page, settings, workspace or agent-settings')
    if (view.order !== undefined && (!Number.isSafeInteger(view.order) || Math.abs(view.order) > 10000)) throw new PluginError('Invalid plugin view order')
    if (['workspace', 'agent-settings'].includes(view.slot)) {
      if (!view.icon || !Object.hasOwn(PLUGIN_ICON_PATHS, view.icon)) throw new PluginError('Plugin configuration sidebar pages require a named icon')
    } else if (view.icon !== undefined && !Object.hasOwn(PLUGIN_ICON_PATHS, view.icon)) validateIcon(view.icon)
    ids.add(view.id)
    if (!m.client || !m.permissions.includes('ui')) throw new PluginError('Views require a client entry and ui capability')
  }
  if (m.navigation !== undefined) {
    if (!m.navigation || typeof m.navigation !== 'object' || Array.isArray(m.navigation) || Object.keys(m.navigation).some(key => !['main', 'settings'].includes(key))) throw new PluginError('Invalid plugin navigation')
    for (const slot of ['main', 'settings'] as const) {
      const entries = m.navigation[slot]
      if (entries === undefined) continue
      if (!Array.isArray(entries) || entries.length > 50) throw new PluginError('Invalid plugin navigation entries')
      const targets = new Set<string>()
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['viewId', 'title', 'icon', 'order'].includes(key))) throw new PluginError('Invalid plugin navigation entry')
        if (!ids.has(entry.viewId) || targets.has(entry.viewId)) throw new PluginError('Navigation must target a distinct declared view')
        if (entry.title !== undefined && (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 160)) throw new PluginError('Invalid plugin navigation title')
        if (entry.order !== undefined && (!Number.isSafeInteger(entry.order) || Math.abs(entry.order) > 10000)) throw new PluginError('Invalid plugin navigation order')
        if (typeof entry.icon !== 'string' || !entry.icon) throw new PluginError('Plugin navigation requires an explicit icon')
        if (!Object.hasOwn(PLUGIN_ICON_PATHS, entry.icon)) {
          if (slot === 'settings') throw new PluginError('Settings navigation requires a named icon; images are not supported')
          validateIcon(entry.icon)
        }
        targets.add(entry.viewId)
      }
    }
  }
  if (m.workspace !== undefined) {
    if (!m.workspace || typeof m.workspace !== 'object' || Array.isArray(m.workspace)) throw new PluginError('Invalid plugin workspace')
    identifier(m.workspace.sidebar, 'workspace sidebar view')
    if (ids.has(m.workspace.sidebar) || !m.views?.some(view => view.slot === 'workspace')) throw new PluginError('Workspace sidebar requires workspace pages and a distinct view id')
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
