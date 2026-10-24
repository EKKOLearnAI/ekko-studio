import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, join } from 'node:path'
import { StudioError, type PluginManifest } from '../../contracts/plugins'
import { parseManifest } from './validation'

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path)
}

export async function inspectPluginArtifact(directory: string): Promise<{ manifest: PluginManifest; entry: string; digest: string }> {
  const root = await realpath(directory)
  const hash = createHash('sha256')
  let bytes = 0, count = 0
  async function walk(path: string): Promise<void> {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 10_000 || item.isSymbolicLink()) throw new StudioError('INVALID_ARGUMENT', 'Plugin contains links or too many files')
      const child = join(path, item.name)
      if (!within(root, await realpath(child))) throw new StudioError('INVALID_ARGUMENT', 'Plugin path escapes its artifact')
      if (item.isDirectory()) await walk(child)
      else if (item.isFile()) {
        const size = (await stat(child)).size
        bytes += size
        if (bytes > 100 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Plugin artifact is too large')
        const content = await readFile(child)
        hash.update(relative(root, child).split('\\').join('/')).update('\0').update(String(content.length)).update('\0').update(content)
      } else throw new StudioError('INVALID_ARGUMENT', 'Plugin contains unsupported file types')
    }
  }
  await walk(root)
  const manifest = parseManifest(JSON.parse(await readFile(join(root, 'studio-plugin.json'), 'utf8')))
  const entry = await realpath(resolve(root, manifest.backend))
  if (!within(root, entry) || !(await stat(entry)).isFile()) throw new StudioError('INVALID_ARGUMENT', 'Plugin entry escapes its artifact')
  return { manifest, entry, digest: hash.digest('hex') }
}

export async function stagePluginArtifact(source: string, artifactsRoot: string): Promise<{ manifest: PluginManifest; generation: string; artifactPath: string }> {
  const sourceRoot = await realpath(source)
  const targetRoot = resolve(artifactsRoot)
  if (within(sourceRoot, targetRoot)) throw new StudioError('INVALID_ARGUMENT', 'Plugin source cannot contain the installation directory')
  await inspectPluginArtifact(sourceRoot)
  await mkdir(targetRoot, { recursive: true })
  const staging = join(targetRoot, `.staging-${randomUUID()}`)
  try {
    await cp(sourceRoot, staging, { recursive: true, dereference: false, errorOnExist: true })
    const inspected = await inspectPluginArtifact(staging)
    const generation = `${inspected.manifest.version}-${inspected.digest}`
    const destination = join(targetRoot, inspected.manifest.id, generation)
    await mkdir(join(targetRoot, inspected.manifest.id), { recursive: true })
    try { await rename(staging, destination) }
    catch (error) {
      const existing = await inspectPluginArtifact(destination).catch(() => null)
      if (!existing || existing.digest !== inspected.digest) throw error
    }
    return { manifest: inspected.manifest, generation, artifactPath: destination }
  } finally { await rm(staging, { recursive: true, force: true }) }
}
