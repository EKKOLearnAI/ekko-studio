import type { JsonObject, JsonValue } from '../../../studio-plugin-sdk/src/types'

export interface AgentConfigField { key: string; type: string; enum?: JsonValue[]; required: boolean; maxLength?: number }
/** Unsupported schema shapes remain editable as a full JSON object. Server
 * validation is authoritative, including refs, limits and conditional schemas. */
export function agentConfigFields(schema: JsonObject | boolean): AgentConfigField[] | null {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)
    || Object.keys(schema).some(key => ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'patternProperties'].includes(key))) return null
  const fields: AgentConfigField[] = []
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(String(value.type))) return null
    fields.push({ key, type: String(value.type), required: Array.isArray(schema.required) && schema.required.includes(key),
      ...(Array.isArray(value.enum) ? { enum: value.enum } : {}), ...(typeof value.maxLength === 'number' ? { maxLength: value.maxLength } : {}) })
  }
  return fields
}
export function parseAgentConfigFields(fields: AgentConfigField[], drafts: Record<string, string>, original: JsonObject = {}): JsonObject {
  // Retain fields outside the current form; schema validation will decide
  // whether they are still supported instead of silently losing saved values.
  const config = { ...original }
  for (const field of fields) {
    const value = drafts[field.key] ?? ''
    if (!value && !field.required) {
      if (!(field.type === 'string' && original[field.key] === '')) delete config[field.key]
      continue
    }
    if (!value && field.required) throw new Error(field.key)
    try {
      const parsed: JsonValue = field.type === 'string' ? value : JSON.parse(value)
      if ((field.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
        || (field.type === 'array' && !Array.isArray(parsed)) || (field.type === 'boolean' && typeof parsed !== 'boolean')
        || (['number', 'integer'].includes(field.type) && (typeof parsed !== 'number' || !Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))))) throw new Error(field.key)
      Object.defineProperty(config, field.key, { value: parsed, enumerable: true, configurable: true, writable: true })
    } catch { throw new Error(field.key) }
  }
  return config
}
