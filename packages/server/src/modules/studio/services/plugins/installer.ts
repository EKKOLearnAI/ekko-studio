import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginManifest } from '../../contracts/plugins'
import { manifest } from './schema'
import { PLUGIN_ICON_PATHS } from '../../contracts/plugins'
import { PluginError } from './errors'
import { windowsCmdShimExecution } from '../../public/windows-command'
import { builtinPluginDirectory } from './builtin-directory'

export async function pluginFile(directory: string, entry: string): Promise<string> {
  const root = await realpath(directory)
  const file = await realpath(resolve(root, entry))
  const offset = relative(root, file)
  if (!offset || offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset) || !(await stat(file)).isFile()) throw new PluginError('Plugin entry escapes its package')
  return file
}
export async function readManifest(directory: string, options: { validateEntries?: boolean } = {}): Promise<PluginManifest> {
  const path = await pluginFile(directory, 'package.json')
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  const manifestPath = await pluginFile(directory, 'plugin.json').catch(error => {
    if (error.code === 'ENOENT') throw new PluginError('Plugin package must include plugin.json')
    throw error
  })
  const result = manifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (pkg.version !== undefined && pkg.version !== result.version) throw new PluginError('Package and plugin versions must match')
  if (options.validateEntries !== false) for (const entry of [result.server, result.client].filter(Boolean)) await pluginFile(directory, entry!)
  async function icon(value: string | undefined): Promise<string | undefined> {
    if (!value || value.startsWith('data:') || Object.hasOwn(PLUGIN_ICON_PATHS, value)) return value
    const file = await pluginFile(directory, value)
    if ((await stat(file)).size > 256_000) throw new PluginError('Plugin icon exceeds 256 KB')
    const type = /\.jpe?g$/i.test(value) ? 'jpeg' : value.split('.').at(-1)!.toLowerCase()
    return `data:image/${type};base64,${(await readFile(file)).toString('base64')}`
  }
  if (result.icon) result.icon = await icon(result.icon)
  for (const view of result.views || []) if (view.icon) view.icon = await icon(view.icon)
  for (const entry of result.navigation?.main || []) entry.icon = (await icon(entry.icon))!
  return manifest(result)
}
export async function installPackage(root: string, source: string): Promise<{ manifest: PluginManifest; directory: string; dispose: () => Promise<void> }> {
  if (typeof source !== 'string' || !source.trim() || source.length > 2048) throw new PluginError('Plugin package source is required')
  const stage = join(root, 'versions', randomUUID())
  await mkdir(stage, { recursive: true, mode: 0o700 })
  const dispose = () => rm(stage, { recursive: true, force: true })
  try {
    let directory: string
    if (isAbsolute(source) || source.startsWith('builtin:')) {
      const real = await realpath(source.startsWith('builtin:') ? builtinPluginDirectory(source.slice(8)) : source)
      if (!(await stat(real)).isDirectory()) throw new PluginError('Local plugin source must be a directory')
      if (stage.startsWith(`${real}${sep}`)) throw new PluginError('Plugin source contains its installation directory')
      await readManifest(real)
      directory = join(stage, 'package')
      await cp(real, directory, { recursive: true, dereference: false, filter: path => !/^(?:\.git|\.env(?:\..*)?)$/.test(path.split(sep).at(-1) || '') })
    } else {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source)
        && !/^github:[\w.-]+\/[\w.-]+#[a-f0-9]{40}$/.test(source)
        && !/^git\+https:\/\/(?:gitlab\.com|gitee\.com)\/[\w.-]+(?:\/[\w.-]+)+\.git#[a-f0-9]{40}$/.test(source)) throw new PluginError('Use an absolute directory, package@exact-version or a supported repository pinned to a full commit')
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const args = ['install', '--prefix', stage, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true', '--', source]
      const execution = process.platform === 'win32' ? windowsCmdShimExecution(npm, args) : { command: npm, args }
      await new Promise<void>((done, reject) => execFile(execution.command, execution.args,
        { ...('windowsVerbatimArguments' in execution ? { windowsVerbatimArguments: true } : {}), timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }, error => error ? reject(new PluginError('Package installation failed; check the package version, network and npm access', 'PLUGIN_INSTALL', 422)) : done()))
      const pkg = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
      const names = Object.keys(pkg.dependencies || {})
      if (names.length !== 1 || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(names[0])) throw new PluginError('Unable to locate installed plugin package')
      directory = join(stage, 'node_modules', names[0])
    }
    const result = await readManifest(directory)
    if (source.startsWith('builtin:') && result.id !== source.slice(8)) throw new PluginError('Bundled plugin id does not match its directory')
    return { manifest: result, directory, dispose }
  } catch (error) { await dispose(); throw error }
}
