// Real Qoder metadata acceptance with disposable native storage; no account or inference.
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const project = fileURLToPath(new URL('..', import.meta.url))
const nativeCommand = process.env.STUDIO_QODER_COMMAND
if (!nativeCommand) throw new Error('Set STUDIO_QODER_COMMAND to the installed Qoder JavaScript entry point')
const root = await mkdtemp(join(tmpdir(), 'studio-qoder-native-'))
let processes
const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 20_000)
try {
  const module = join(root, 'managed.cjs')
  await build({ stdin: { contents: `export { ManagedProcessScope } from './packages/server/src/modules/studio/services/processes/managed'`, resolveDir: project, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node24.22.1', outfile: module, external: ['node-pty'],
    alias: { '@ekko-studio/plugin-sdk': join(project, 'packages/studio-plugin-sdk/src/index.ts') }, logLevel: 'silent' })
  const { ManagedProcessScope } = createRequire(import.meta.url)(module)
  processes = new ManagedProcessScope(controller.signal, () => controller.signal.throwIfAborted())
  const plugin = createRequire(import.meta.url)(join(project, 'dist/plugins/qoder/dist/index.cjs'))
  let agent
  plugin.apply({ agents: { register(value) { assert.equal(value.id, 'qoder'); agent = value } } })
  const nativeHome = join(root, 'native'), workspace = join(root, 'workspace')
  await mkdir(nativeHome); await mkdir(workspace)
  await writeFile(join(nativeHome, 'settings.json'), JSON.stringify({ general: { enableAutoUpdate: false } }))
  const input = { mode: 'global', config: { cwd: workspace, command: process.execPath, args: [resolve(nativeCommand)],
    env: { HOME: root, USERPROFILE: root, QODER_CONFIG_DIR: nativeHome, NO_BROWSER: '1' } } }
  const methods = []
  const context = { signal: controller.signal, processes: { async spawn(input) {
    const handle = await processes.api.spawn(input)
    return { ...handle, async write(data) {
      for (const line of new TextDecoder().decode(data).trim().split('\n')) methods.push(JSON.parse(line).method)
      return handle.write(data)
    } }
  } } }
  const setup = await agent.management.setup(input, context)
  assert.deepEqual(setup.cli, { state: 'available', version: '1.1.78' })
  const install = await agent.management.prepareInstall(input, context)
  assert.deepEqual(install, { kind: 'npm', packageName: '@qoder-ai/qodercli', version: '1.1.78', bin: 'qoder', runner: 'node' })
  const login = await agent.management.prepareLogin(input, context)
  assert.deepEqual(login.args, [resolve(nativeCommand), 'login'])
  const inspection = await agent.management.inspect(input, context)
  assert.equal(inspection.native.version, '1.1.78')
  assert.equal(inspection.authentication.state, 'unknown')
  assert(inspection.authentication.methods.some(method => method.id === 'qodercli-login'))
  assert.deepEqual(methods, ['initialize'])
  const resources = await agent.management.locations(input, context)
  assert.equal(resources.skills[0].path, join(nativeHome, 'skills'))
  // Inspection can create native diagnostics, but never a conversation.
  async function historyFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      assert(!/session.*\.jsonl$|conversation.*\.json$/i.test(entry.name), `Unexpected native history: ${path}`)
      if (entry.isDirectory()) await historyFiles(path)
    }
  }
  await historyFiles(nativeHome)
  assert.equal((await readFile(join(nativeHome, 'settings.json'), 'utf8')).includes('enableAutoUpdate'), true)
  console.log(JSON.stringify({ passed: true, nativeVersion: inspection.native.version, setup: true, acpInspection: true,
    authentication: inspection.authentication.state, resources: true, loginPlan: true, accountLogin: false, remoteProvider: false }))
} finally {
  clearTimeout(deadline)
  await processes?.close()
  await rm(root, { recursive: true, force: true })
}
