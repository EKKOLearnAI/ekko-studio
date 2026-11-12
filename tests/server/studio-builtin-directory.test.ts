import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { builtinPluginDirectory, builtinPluginIds } from '../../packages/server/src/modules/studio/services/plugins/builtin-directory'

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'builtin-packages-')); homes.push(home)
  const root = join(home, 'plugins/builtin'), source = join(home, 'node_modules/fixture-omp')
  await mkdir(root, { recursive: true })
  await mkdir(source, { recursive: true })
  await writeFile(join(root, 'packages.json'), JSON.stringify({ omp: 'fixture-omp' }))
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'omp' }))
  return { root, source }
}
it('resolves independent packages for source development and prefers bundled files in a release', async () => {
  const { root, source } = await setup()
  expect(builtinPluginIds(root)).toEqual(['omp'])
  expect(builtinPluginDirectory('omp', root)).toBe(await realpath(source))
  const bundled = join(root, 'omp')
  await mkdir(bundled)
  await writeFile(join(bundled, 'plugin.json'), JSON.stringify({ id: 'omp' }))
  await rm(source, { recursive: true })
  expect(builtinPluginIds(root)).toEqual(['omp'])
  expect(builtinPluginDirectory('omp', root)).toBe(bundled)
})
it('reports missing dependencies and rejects invalid plugin identifiers', async () => {
  const { root } = await setup()
  await writeFile(join(root, 'packages.json'), JSON.stringify({ omp: 'fixture-not-installed' }))
  expect(() => builtinPluginDirectory('omp', root)).toThrow('install Studio dependencies')
  expect(() => builtinPluginDirectory('../omp', root)).toThrow()
})
