import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { anchorDshPatch, dshPresetSourceConfig, optionalDshFile } from './web-profile'
import { dshInstallation, dshPackageDirectory } from './installation'
import { DSH_UI_SLOT_CLIENT, DSH_UI_SLOT_HOST } from './ui-slot'

/** An owned Web host with the source profile's plugins and a configuration slot.
 * Native packages stay installed externally; Studio bundles no DSH/React code. */
export async function prepareDshManagementProfile(input: { command: string; sourceHome: string; rootDir: string }) {
  const installation = await dshInstallation(input.command)
  const source = join(input.sourceHome, 'profiles/web')
  const manifestPath = join(source, 'package.json')
  const manifest = JSON.parse(await optionalDshFile(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })))
  const bundles: unknown = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('@deepseek-ai/dsh-web-app') || !bundles.includes('@deepseek-ai/dsh-base') || bundles.some(name => typeof name !== 'string')) throw new Error('Invalid native DSH Web profile')
  const profile = 'studio-plugins'
  const directory = join(input.rootDir, 'profiles', profile)
  await mkdir(directory, { recursive: true })
  const layers: string[] = []
  for (const name of new Set([...bundles, ...Object.keys(manifest.dependencies || {})])) {
    const target = await dshPackageDirectory(name, [installation, manifestPath])
    if (bundles.includes(name)) {
      const pkg = JSON.parse(await optionalDshFile(join(target, 'package.json')))
      if (typeof pkg.dsh?.bundle?.patch !== 'string') throw new Error(`Web bundle ${name} has no composition patch`)
      layers.push(await optionalDshFile(join(target, pkg.dsh.bundle.patch)))
    }
    const link = join(directory, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  // Keep a version on every generated manifest: DSH's package-inventory request extension
  // rejects an owning manifest whose name or version is missing.
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : profile
  const version = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version : '0.0.0'
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, name, version, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, patchReload: 'startup' } } }))
  for (const [target, sourcePath] of [[join(directory, 'cordis.patch.yml'), join(source, 'cordis.patch.yml')], [join(input.rootDir, 'cordis.patch.yml'), join(input.sourceHome, 'cordis.patch.yml')]]) {
    const content = await optionalDshFile(sourcePath, '[]')
    layers.push(content)
    await writeFile(target, anchorDshPatch(content, sourcePath), { mode: 0o600 })
  }
  const slot = join(directory, 'node_modules/studio-dsh-ui')
  await mkdir(slot, { recursive: true })
  await writeFile(join(slot, 'package.json'), JSON.stringify({ name: 'studio-dsh-ui', version: '0.0.0', type: 'module', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { client: { platform: 'web', immediately: true, inject: ['slots', 'layout', 'locale', 'theme'], external: ['react'] } } }))
  await writeFile(join(slot, 'index.js'), DSH_UI_SLOT_HOST)
  await writeFile(join(slot, 'client.js'), DSH_UI_SLOT_CLIENT)
  const patch = join(input.rootDir, 'management.patch.yml')
  await writeFile(patch, stringify([
    { id: 'ui-sidebar', disabled: true },
    { id: 'agent-presets', inject: ['settings'], config: dshPresetSourceConfig(layers, input.sourceHome) },
    { id: 'web-runtime', config: { printUrl: false, openBrowser: false, surfaceContext: false } },
    { id: 'settings', config: { path: join(input.sourceHome, 'settings.yaml') } },
    { id: 'credentials', config: { path: join(input.sourceHome, '.credentials.yaml'), dshHome: input.sourceHome } },
    { insert: [{ id: 'studio-dsh-ui', name: 'studio-dsh-ui' }] },
  ]), { mode: 0o600 })
  return { profile, patch }
}
