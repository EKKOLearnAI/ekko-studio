import { isAbsolute } from 'node:path'
import { StudioError, type AgentResourceLocations, type JsonValue } from '../../contracts/plugins'
import { compileSchema, jsonCopy } from '../plugins/validation'

const fields = {
  id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
  name: { type: 'string', minLength: 1, maxLength: 256 },
  path: { type: 'string', minLength: 1, maxLength: 4096 },
  scope: { enum: ['global', 'scoped', 'workspace', 'shared', 'builtin'] }, readOnly: { type: 'boolean' },
}
const required = ['id', 'name', 'path', 'scope', 'readOnly']
const validate = compileSchema({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  skills: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required, properties: fields } },
  configs: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: [...required, 'kind'],
    properties: { ...fields, kind: { enum: ['file', 'directory'] }, format: { type: 'string', minLength: 1, maxLength: 64 } } } },
} })
export function parseAgentResourceLocations(value: unknown): AgentResourceLocations {
  const result = jsonCopy(value, 262144) as AgentResourceLocations
  validate(result as unknown as JsonValue)
  for (const locations of [result.skills || [], result.configs || []]) {
    if (new Set(locations.map(item => item.id)).size !== locations.length || locations.some(item => !isAbsolute(item.path) || item.path.includes('\0')
      || (['shared', 'builtin'].includes(item.scope) && !item.readOnly))) throw new StudioError('INVALID_ARGUMENT', 'Invalid native resource locations')
  }
  return result
}
