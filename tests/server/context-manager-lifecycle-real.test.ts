import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return home.value } } }))

// Opt-in network check: never install packages or start a proxy in a normal unit run.
it.skipIf(process.env.STUDIO_BILI_LIFECYCLE_REAL !== '1')('installs, starts, stops and upgrades the official package in isolated state', async () => {
  home.value = await mkdtemp(join(tmpdir(), 'studio-bili-lifecycle-real-'))
  const { saveContextManagerSettings } = await import('../../packages/server/src/modules/studio/services/context-manager/settings')
  const { runContextManagerLifecycle } = await import('../../packages/server/src/modules/studio/services/context-manager/lifecycle')
  const { getContextManagerHealth } = await import('../../packages/server/src/modules/studio/services/context-manager/health')
  const spare = createServer()
  await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve))
  const port = (spare.address() as { port: number }).port
  await new Promise<void>(resolve => spare.close(() => resolve()))
  const proxyUrl = `http://127.0.0.1:${port}`
  await saveContextManagerSettings('default', { proxyUrl })
  try {
    const installed = await runContextManagerLifecycle('default', 'ekko', 'install')
    expect(installed.lifecycle).toMatchObject({ installed: true, running: false, management: 'none' })
    expect(installed.lifecycle.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(await runContextManagerLifecycle('default', 'hermes', 'start')).toMatchObject({
      lifecycle: { running: true, management: 'studio', runtimeOrigin: proxyUrl },
    })
    const health = await getContextManagerHealth('default')
    expect(health.healthy).toBe(true)
    expect(health.runtimeVersion).toBe(installed.lifecycle.version)
    expect(health.observations.manifest.available).toBe(true)
    expect(health.compatibilityIssues.filter(issue => issue !== 'fork')).toEqual([])
    expect(await runContextManagerLifecycle('default', 'hermes', 'stop')).toMatchObject({ lifecycle: { running: false } })
    const upgraded = await runContextManagerLifecycle('default', 'ekko', 'upgrade')
    expect(upgraded.lifecycle).toMatchObject({ installed: true, running: false, version: installed.lifecycle.version })
    expect(await runContextManagerLifecycle('default', 'ekko', 'start')).toMatchObject({ lifecycle: { running: true } })
    expect((await getContextManagerHealth('default')).runtimeVersion).toBe(upgraded.lifecycle.version)
    expect(await runContextManagerLifecycle('default', 'ekko', 'stop')).toMatchObject({ lifecycle: { running: false } })
    console.log(JSON.stringify({ packageVersion: upgraded.lifecycle.version, proxyUrl, compatibility: health.compatibility, issues: health.compatibilityIssues }))
  } finally {
    await runContextManagerLifecycle('default', 'ekko', 'stop').catch(() => {})
    await rm(home.value, { recursive: true, force: true })
  }
}, 240_000)