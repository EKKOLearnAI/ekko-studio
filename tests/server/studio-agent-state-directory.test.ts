import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
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

it('retains existing paths and checkpoints after a compatible update and worker restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-state-')), db = new DatabaseSync(':memory:')
  try {
    let store = new AgentExecutionStore(db)
    const provider = { kind: 'plugin' as const, pluginId: 'fixture', version: '1.0.0', generation: 'one' }
    const instance = store.createInstance({ agentTypeId: 'fixture', ownerId: 'owner', profileId: 'one', config: {}, mode: 'scoped' })
    const original = await agentStateDirectory(root, instance, provider)
    store.state.saveCheckpoint(instance.id, provider, 1, 'old-run', { native: 'session' })
    const updated = store.configureInstance(instance, { revision: 1, mode: 'scoped', config: { model: 'next' } }, provider)
    store = new AgentExecutionStore(db)
    // Production generations identify artifact digests and remain stable on worker restart.
    const restarted = { ...provider }
    expect(await agentStateDirectory(root, updated, restarted, store.state.stateRevision(instance.id, restarted, 2))).toBe(original)
    expect(store.state.checkpoint(instance.id, restarted, 2)).toEqual({ native: 'session' })
    for (const other of [{ ...restarted, version: '2.0.0' }, { ...restarted, pluginId: 'other' }, { ...restarted, generation: 'different-artifact' }]) {
      expect(store.state.stateRevision(instance.id, other, 2)).toBe(2)
      expect(store.state.checkpoint(instance.id, other, 2)).toBeUndefined()
    }
    expect(store.state.checkpoint('other-instance', restarted, 2)).toBeUndefined()
    // A fresh store over the legacy tables needs no destructive migration or directory copy.
    expect(store.state.stateRevision(instance.id, provider, 1)).toBe(1)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
