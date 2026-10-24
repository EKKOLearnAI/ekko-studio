import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { agentStateDirectory } from '../../packages/server/src/modules/studio/services/agents/state-directory'

it('keeps native history stable across worker generations and isolates every persisted identity dimension', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-state-'))
  try {
    const instance = { id: '../instance', ownerId: '../owner', profileId: '../profile', revision: 1, mode: 'scoped' as const, agentTypeId: 'fixture', config: {} }
    const provider = { kind: 'plugin' as const, pluginId: 'fixture', version: '1.0.0', generation: 'one' }
    const first = await agentStateDirectory(root, instance, provider)
    expect(dirname(first)).toBe(root)
    expect(basename(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(await agentStateDirectory(root, instance, { ...provider, generation: 'two' })).toBe(first)
    for (const patch of [{ ownerId: 'other' }, { profileId: 'other' }, { id: 'other' }, { revision: 2 }]) {
      expect(await agentStateDirectory(root, { ...instance, ...patch }, provider)).not.toBe(first)
    }
    for (const patch of [{ pluginId: 'another' }, { version: '2.0.0' }]) expect(await agentStateDirectory(root, instance, { ...provider, ...patch })).not.toBe(first)
    if (process.platform !== 'win32') expect((await stat(first)).mode & 0o777).toBe(0o700)
  } finally { await rm(root, { recursive: true, force: true }) }
})
