import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument, stringify, type YAMLMap } from 'yaml'
import { dshInstallation, dshPackageDirectory } from './installation'
import { writeDshAcpAdapter } from './acp-adapter'

const WEB_BACKEND_ROWS = new Set([
  'subagent-model-selection-settings', 'code-runtime', 'message-feedback',
  'workspace', 'session-reference', 'file-reference-local', 'session-stats',
  'session-turn-outline', 'cordis-host-runner', 'agent-presets',
])

export async function optionalDshFile(path: string, fallback = '') {
  try { return await readFile(path, 'utf8') }
  catch (error: any) { if (error.code === 'ENOENT') return fallback; throw error }
}

export function dshPatchDocument(content: string) {
  const doc = parseDocument(content || '[]\n', { logLevel: 'silent' })
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Invalid DSH composition patch')
  return doc
}

/** Preserve native patch-relative module/include paths when snapshotting data. */
export function anchorDshPatch(content: string, filename: string) {
  const doc = dshPatchDocument(content)
  const entries = (items: unknown[]) => {
    for (const item of items) {
      if (!isMap(item)) continue
      const name = item.get('name')
      if (typeof name === 'string' && (isAbsolute(name) || /^\.\.?[/\\]/.test(name))) item.set('name', pathToFileURL(resolve(dirname(filename), name)).href)
      if (name === '@deepseek-ai/cordis-plugin-include') {
        const path = item.getIn(['config', 'path'])
        if (typeof path === 'string' && !isAbsolute(path)) item.setIn(['config', 'path'], resolve(dirname(filename), path))
      }
      if (item.get('group') === true && isSeq(item.get('config', true))) entries((item.get('config', true) as any).items)
    }
  }
  for (const item of (doc.contents as any).items) if (isMap(item) && isSeq(item.get('insert', true))) entries((item.get('insert', true) as any).items)
  return String(doc)
}

/** Read Web configuration and produce a private ACP launch profile. No native
 * config, package, lockfile or dependency directory is modified by preparation. */
export async function prepareDshWebProfile(input: { command: string; sourceHome: string; rootDir: string; model?: string }) {
  const installation = await dshInstallation(input.command)
  const sourceProfile = join(input.sourceHome, 'profiles/web')
  const manifestPath = join(sourceProfile, 'package.json')
  const manifestText = await optionalDshFile(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  const manifest = JSON.parse(manifestText)
  const bundles: unknown = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app') || !bundles.includes('@deepseek-ai/dsh-base') || bundles.some(name => typeof name !== 'string')) throw new Error('DSH Web profile must declare the native base and Web bundles')
  const profilePatch = await optionalDshFile(join(sourceProfile, 'cordis.patch.yml'), '[]\n')
  const homePatch = await optionalDshFile(join(input.sourceHome, 'cordis.patch.yml'), '[]\n')
  const anchors = [installation, manifestPath]
  const layers: string[] = []
  const dependencies = new Map<string, string>()
  for (const name of new Set([...bundles, ...Object.keys(manifest.dependencies || {}), '@deepseek-ai/dsh-acp-app'])) {
    dependencies.set(name, await dshPackageDirectory(name, anchors))
  }
  for (const name of bundles) {
    const directory = dependencies.get(name)!
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (typeof pkg.dsh?.bundle?.patch !== 'string') throw new Error(`Web bundle ${name} has no composition patch`)
    layers.push(await readFile(join(directory, pkg.dsh.bundle.patch), 'utf8'))
  }
  const generation = createHash('sha256').update(JSON.stringify([installation, manifestText, profilePatch, homePatch, layers, [...dependencies]])).digest('hex').slice(0, 16)
  const profile = `studio-web-${generation}`
  const directory = join(input.rootDir, 'profiles', profile)
  await mkdir(directory, { recursive: true })
  for (const [name, target] of dependencies) {
    const link = join(directory, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error: any) { if (error.code !== 'EEXIST') throw error }
  }
  // Declare a version: DSH resolves this file as the owning manifest of the profile's
  // `file://` plugin rows (studio-acp.mjs), and its package-inventory request extension
  // rejects an owning manifest that lacks a non-empty name or version.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: profile, version: '0.0.0', private: true,
    dsh: { profile: { bundles: [...bundles, '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' } } }, null, 2))
  await writeFile(join(directory, 'cordis.patch.yml'), anchorDshPatch(profilePatch, join(sourceProfile, 'cordis.patch.yml')), { mode: 0o600 })
  const webIndex = bundles.indexOf('@deepseek-ai/dsh-web-app')
  const web = dshPatchDocument(layers[webIndex])
  const disabled: string[] = []
  for (const patch of (web.contents as any).items) {
    if (!isMap(patch) || !isSeq(patch.get('insert', true))) continue
    for (const row of (patch.get('insert', true) as any).items) {
      if (isMap(row) && typeof row.get('id') === 'string' && !WEB_BACKEND_ROWS.has(String(row.get('id')))) disabled.push(String(row.get('id')))
    }
  }
  const adapterPath = join(directory, 'studio-acp.mjs')
  await writeDshAcpAdapter(installation, adapterPath, dependencies.get('@deepseek-ai/dsh-acp-app')!)
  const adaptation = dshPatchDocument(stringify([
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'acp', disabled: true },
    { insert: [{ id: 'studio-web-acp', name: pathToFileURL(adapterPath).href, inject: ['acpAppStartup', 'agentPresets', 'agentDefaultModel', 'settings'], config: {} }] },
    // Web presets provide per-agent skills. Keep Studio/shared skills available
    // globally as an additional source rather than replacing preset providers.
    { id: 'skill-filesystem', disabled: false },
  ]))
  const adapterRow = (adaptation.contents as any).items[disabled.length + 1].get('insert').items[0]
  const modelConfig = parseDocument('provider: !!js ctx.agentDefaultModel.currentSelection().provider\nmodel: !!js ctx.agentDefaultModel.currentSelection().model\n', { logLevel: 'silent' })
  adapterRow.set('config', modelConfig.contents)
  adaptation.add({ id: 'agent-presets', inject: ['settings'], config: dshPresetSourceConfig([...layers, profilePatch, homePatch], input.sourceHome) })
  adaptation.add({ id: 'agent-default-model', inject: ['settings'] })
  const path = join(directory, 'web-acp.patch.yml')
  await writeFile(path, String(adaptation), { mode: 0o600 })
  await writeFile(join(directory, 'source.json'), JSON.stringify({ sourceHome: input.sourceHome, sourceProfile: 'web', generation, browserRuntime: false, excludedWebRows: disabled }, null, 2))
  return { profile, patch: path, sourceProfile, generation }
}

/** Share native preset discovery and authoring roots between Web management and ACP. */
export function dshPresetSourceConfig(layers: string[], sourceHome: string): YAMLMap {
  // Cordis patches replace config wholesale. Preserve the final preset config
  // from the same ordered source layers, then anchor its user root explicitly.
  let presetConfig: YAMLMap | undefined
  for (const text of layers) {
    const doc = dshPatchDocument(text)
    for (const patch of (doc.contents as any).items) {
      if (!isMap(patch)) continue
      const candidates = [patch, ...(isSeq(patch.get('insert', true)) ? (patch.get('insert', true) as any).items : [])]
      for (const row of candidates) if (isMap(row) && row.get('id') === 'agent-presets' && isMap(row.get('config', true))) presetConfig = (row.get('config', true) as unknown as YAMLMap).clone() as YAMLMap
    }
  }
  presetConfig ??= parseDocument('default: standard\n').contents as YAMLMap
  const roots = presetConfig.get('roots', true)
  if (roots !== undefined && !isSeq(roots)) throw new Error('DSH Web preset roots must be a static sequence')
  const configuredRoots = roots ? (roots as any).clone() : parseDocument('[]').contents!
  if (presetConfig.get('includeUserRoot') !== false) configuredRoots.add({ path: join(sourceHome, '.agent-presets'), trust: 'user' })
  presetConfig.set('roots', configuredRoots)
  presetConfig.set('includeUserRoot', false)
  return presetConfig
}
