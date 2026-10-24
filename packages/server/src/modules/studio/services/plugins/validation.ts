import Ajv from 'ajv'
import { valid, validRange, satisfies, major } from 'semver'
import {
  StudioError, STUDIO_SDK_VERSION,
  type JsonValue, type JsonSchema, type PluginManifest, type AgentTypeDefinition, type AgentOutputEvent, type ServiceToken, type AgentInspection,
} from '../../contracts/plugins'

const ajv = new Ajv({ allErrors: false, strict: true, validateFormats: false, allowUnionTypes: true })
const idPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/

export function jsonCopy<T>(value: T, maxBytes = 1_048_576): T {
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new StudioError('INVALID_ARGUMENT', 'JSON nesting limit exceeded')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object') throw new StudioError('INVALID_ARGUMENT', 'Expected a JSON value')
    if (ancestors.has(item)) throw new StudioError('INVALID_ARGUMENT', 'Cyclic JSON value')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new StudioError('INVALID_ARGUMENT', 'Expected a plain JSON object')
    }
    ancestors.add(item)
    for (const key of Object.keys(item)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new StudioError('INVALID_ARGUMENT', 'Reserved JSON property')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !('value' in descriptor)) throw new StudioError('INVALID_ARGUMENT', 'JSON accessors are not allowed')
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(item)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > maxBytes) throw new StudioError('RESOURCE_EXHAUSTED', 'JSON size limit exceeded')
  return JSON.parse(encoded) as T
}

/** Validate at the wire boundary before treating an interface DTO as a JSON value. */
export function toJson(value: unknown): JsonValue { return jsonCopy(value) as JsonValue }

export function validatePluginId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length > 128 || !idPattern.test(id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin id')
}

export function compileSchema(schema: JsonSchema): (value: JsonValue) => void {
  let validate
  try { validate = new Ajv({ allErrors: false, strict: true, validateFormats: false }).compile(jsonCopy(schema, 65_536)) }
  catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid or unsupported JSON schema') }
  return value => {
    if (!validate(jsonCopy(value))) throw new StudioError('INVALID_ARGUMENT', 'Value does not match its declared schema')
  }
}

const serviceId = { type: 'string', maxLength: 256, pattern: '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+/[a-z][a-z0-9-]*@[1-9][0-9]*$' }
const serviceSchema = { type: 'object', additionalProperties: false, required: ['id', 'version', 'methods'], properties: {
  id: serviceId, version: { type: 'string', maxLength: 64 },
  methods: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: '^[a-z][a-zA-Z0-9]*$', maxLength: 128, not: { enum: ['constructor', 'prototype'] } }, additionalProperties: {
    type: 'object', additionalProperties: false, required: ['input', 'output'], properties: { input: { type: ['object', 'boolean'] }, output: { type: ['object', 'boolean'] } },
  } },
} }
const validateService = ajv.compile(serviceSchema)
export function parseServiceToken(value: unknown): ServiceToken {
  const token = jsonCopy(value) as ServiceToken
  if (!validateService(token) || !valid(token.version) || major(token.version) !== Number(token.id.split('@').at(-1))) throw new StudioError('INVALID_ARGUMENT', 'Invalid service token')
  for (const method of Object.values(token.methods)) { compileSchema(method.input); compileSchema(method.output) }
  return token
}

const manifestSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'version', 'engines', 'backend', 'activation', 'contributes', 'requires'],
  properties: {
    schemaVersion: { const: 1 }, id: { type: 'string', maxLength: 128 }, version: { type: 'string', maxLength: 64 },
    engines: { type: 'object', additionalProperties: false, required: ['studioSdk', 'rpc'], properties: { studioSdk: { type: 'string', maxLength: 128 }, rpc: { const: 1 } } },
    backend: { type: 'string', minLength: 1, maxLength: 512 }, activation: { const: 'profile' },
    contributes: { type: 'object', additionalProperties: false, required: ['agents'], properties: {
      agents: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
      events: { type: 'object', maxProperties: 64, additionalProperties: { type: ['object', 'boolean'] } },
      services: { type: 'array', maxItems: 64, items: serviceSchema },
    } },
    requires: { type: 'object', additionalProperties: false, required: ['capabilities'], properties: {
      capabilities: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', maxLength: 256 } },
      services: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'version'], properties: {
        id: serviceId, version: { type: 'string', maxLength: 128 }, optional: { type: 'boolean' },
      } } },
    } },
    configSchema: { type: ['object', 'boolean'] },
  },
} as const
const validateManifestShape = ajv.compile(manifestSchema)

export function parseManifest(value: unknown): PluginManifest {
  const manifest = jsonCopy(value, 131_072)
  if (!validateManifestShape(manifest)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin manifest')
  const result = manifest as PluginManifest
  validatePluginId(result.id)
  if (!valid(result.version) || !validRange(result.engines.studioSdk)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin version range')
  if (!satisfies(STUDIO_SDK_VERSION, result.engines.studioSdk)) throw new StudioError('PLUGIN_VERSION_INCOMPATIBLE', 'Plugin requires a different Studio SDK version')
  if (result.backend.startsWith('/') || result.backend.includes('\\') || result.backend.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(result.backend)) {
    throw new StudioError('INVALID_ARGUMENT', 'Plugin entry must be a relative path inside its artifact')
  }
  if (result.configSchema !== undefined) compileSchema(result.configSchema)
  const provided = new Set<string>(), required = new Set<string>()
  for (const value of result.contributes.services || []) {
    const token = parseServiceToken(value)
    if (!token.id.startsWith(`${result.id}/`) || provided.has(token.id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid or duplicate service publisher')
    provided.add(token.id)
  }
  for (const dependency of result.requires.services || []) {
    if (!validRange(dependency.version) || required.has(dependency.id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid or duplicate service dependency')
    required.add(dependency.id)
  }
  for (const [name, schema] of Object.entries(result.contributes.events || {})) {
    if (!name.startsWith(`${result.id}:`) || !/^[a-z0-9.-]+:[a-z][a-z0-9.-]*$/.test(name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin event namespace')
    compileSchema(schema)
  }
  return result
}

export function validateAgentDefinition(definition: AgentTypeDefinition): void {
  if (typeof definition?.id !== 'string' || !/^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9-]*)?$/.test(definition.id) || definition.id.length > 256) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent type id')
  }
  if (typeof definition.name !== 'string' || !definition.name.trim() || definition.name.length > 200 || typeof definition.create !== 'function') {
    throw new StudioError('INVALID_ARGUMENT', 'Agent requires a name and runtime factory')
  }
  const capabilities = definition.capabilities
  if (definition.management !== undefined && (!definition.management || typeof definition.management.inspect !== 'function'
    || Object.keys(definition.management).some(key => key !== 'inspect'))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent management adapter')
  if (!capabilities || typeof capabilities.text !== 'boolean' || !Array.isArray(capabilities.modes) || !capabilities.modes.length
    || capabilities.modes.some(mode => mode !== 'scoped' && mode !== 'global')) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent capabilities')
  const flags = ['text', 'images', 'files', 'streaming', 'reasoning', 'resume', 'persistentSession', 'compact', 'approvals', 'clarifications', 'steering']
  for (const [key, value] of Object.entries(capabilities)) {
    if (key === 'modes') continue
    if (!flags.includes(key) || typeof value !== 'boolean') throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent capability')
  }
  compileSchema(definition.configSchema)
}

const managementString = { type: 'string', minLength: 1, maxLength: 256 }
const validateInspection = ajv.compile({ type: 'object', additionalProperties: false, required: ['native', 'authentication', 'models'], properties: {
  native: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: managementString, version: managementString } },
  authentication: { type: 'object', additionalProperties: false, required: ['state', 'methods'], properties: {
    state: { enum: ['authenticated', 'required', 'not_required', 'unknown'] },
    methods: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: { id: managementString, name: managementString } } },
  } },
  models: { type: 'object', additionalProperties: false, required: ['status', 'items'], properties: {
    status: { enum: ['available', 'unsupported'] }, items: { type: 'array', maxItems: 512, items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: {
      id: managementString, name: managementString, isDefault: { type: 'boolean' }, reasoningEfforts: { type: 'array', maxItems: 32, uniqueItems: true, items: managementString },
    } } },
  } },
} })
export function parseAgentInspection(value: unknown): AgentInspection {
  const result = jsonCopy(value, 262_144) as AgentInspection
  if (!validateInspection(result) || new Set(result.models.items.map(item => item.id)).size !== result.models.items.length
    || new Set(result.authentication.methods.map(item => item.id)).size !== result.authentication.methods.length
    || (result.models.status === 'unsupported' && result.models.items.length)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent inspection')
  return result
}

const eventSequence = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const eventString = { type: 'string', minLength: 1, maxLength: 256 }
const eventSchema = (types: string[], properties: Record<string, object>, required: string[]) => ({
  type: 'object', additionalProperties: false, required: ['type', 'producerSequence', ...required],
  properties: { type: { enum: types }, producerSequence: eventSequence, ...properties },
})
const validateOutput = ajv.compile({ anyOf: [
  eventSchema(['message.delta', 'message.snapshot', 'reasoning.delta'], { messageId: eventString, text: { type: 'string' } }, ['messageId', 'text']),
  eventSchema(['tool.started', 'tool.completed', 'tool.failed'], { callId: eventString, name: eventString, data: {} }, ['callId', 'name', 'data']),
  eventSchema(['usage.reported'], { modelCallId: eventString, model: eventString, mode: { enum: ['delta', 'cumulative', 'final'] }, revision: eventSequence,
    inputTokens: eventSequence, outputTokens: eventSequence }, ['modelCallId', 'model', 'mode', 'revision', 'inputTokens', 'outputTokens']),
  eventSchema(['checkpoint.updated'], { value: {} }, ['value']),
  eventSchema(['interaction.requested'], {
    requestId: eventString, kind: { enum: ['approval', 'clarification'] }, prompt: { type: 'string', minLength: 1, maxLength: 16384 },
    choices: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: eventString, label: { type: 'string', minLength: 1, maxLength: 1024 }, description: { type: 'string', maxLength: 4096 } } } },
    allowText: { type: 'boolean' },
    expiresAt: eventSequence,
  }, ['requestId', 'kind', 'prompt', 'choices']),
  eventSchema(['interaction.withdrawn'], { requestId: eventString }, ['requestId']),
  eventSchema(['diagnostic'], { message: { type: 'string', maxLength: 4096 } }, ['message']),
] })
export function parseAgentOutput(value: unknown): AgentOutputEvent {
  const event = jsonCopy(value)
  if (!validateOutput(event)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent output event')
  return event as AgentOutputEvent
}
