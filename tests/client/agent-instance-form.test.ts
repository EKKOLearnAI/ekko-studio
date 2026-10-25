import { expect, it } from 'vitest'
import { agentConfigFields, parseAgentConfigFields } from '../../packages/client/src/utils/agent-instance-form'

it('keeps unknown configuration and distinguishes JSON types from native strings', () => {
  const fields = agentConfigFields({ type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' }, env: { type: 'object' }, args: { type: 'array' }, enabled: { type: 'boolean' }, limit: { type: 'integer' } } })!
  expect(parseAgentConfigFields(fields, { cwd: '/workspace', env: '{"TOKEN":"literal"}', args: '["a b","$(literal)"]', enabled: 'false', limit: '0' }, { future: 'preserved' }))
    .toEqual({ future: 'preserved', cwd: '/workspace', env: { TOKEN: 'literal' }, args: ['a b', '$(literal)'], enabled: false, limit: 0 })
  expect(() => parseAgentConfigFields(fields, { cwd: '/workspace', env: '[]' })).toThrow('env')
  expect(() => parseAgentConfigFields(fields, { cwd: '/workspace', limit: '1.2' })).toThrow('limit')
  expect(() => parseAgentConfigFields(fields, {})).toThrow('cwd')
  expect(parseAgentConfigFields([{ key: 'prompt', type: 'string', required: false }], { prompt: '' }, { prompt: '' })).toEqual({ prompt: '' })
})

it('uses full JSON editing for schema forms it cannot represent', () => {
  expect(agentConfigFields({ type: 'object', properties: { custom: { oneOf: [{ type: 'string' }, { type: 'object' }] } } })).toBeNull()
  expect(agentConfigFields({ type: 'object', properties: {}, if: { required: ['x'] } })).toBeNull()
  expect(agentConfigFields(true)).toBeNull()
})
