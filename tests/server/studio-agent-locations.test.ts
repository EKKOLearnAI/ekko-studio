import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parseAgentResourceLocations } from '../../packages/server/src/modules/studio/services/agents/resource-contract'

const location = { id: 'primary', name: 'Skills', path: resolve('fixture/skills'), scope: 'global', readOnly: false }
it('preserves multiple sources, identical names and mixed configuration files/directories', () => {
  const value = { skills: [location, { ...location, id: 'workspace', path: resolve('fixture/workspace/skills'), scope: 'workspace' }],
    configs: [{ ...location, kind: 'directory' }, { ...location, id: 'settings', kind: 'file', format: 'json', path: resolve('fixture/settings.json') }] }
  expect(parseAgentResourceLocations(value)).toEqual(value)
  expect(parseAgentResourceLocations({ skills: [] })).toEqual({ skills: [] })
})

it.each([
  {}, { skills: location }, { configs: location }, { skills: [location, location] },
  { skills: [{ ...location, path: 'relative/skills' }] },
  { skills: [{ ...location, path: '/tmp/invalid\0' }] },
  { skills: [{ ...location, scope: 'shared', readOnly: false }] },
  { skills: [{ ...location, scope: 'builtin', readOnly: false }] },
  { configs: [{ ...location, kind: 'command' }] },
  { configs: [{ ...location, kind: 'file', content: 'should not cross the plugin boundary' }] },
])('rejects malformed or ambiguous location descriptions: %j', value => {
  expect(() => parseAgentResourceLocations(value)).toThrow()
})
