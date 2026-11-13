import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshPackageDirectory } from './installation'

export interface DshPluginMetadata { title: string; description: string; packageName: string; version: string }
export async function readDshPluginMetadata(moduleName: string, anchors: string[]): Promise<DshPluginMetadata | undefined> {
  const match = moduleName.match(/^(@[^/]+\/[^/]+|[^./][^/]*)/)
  if (!match) return
  try {
    const directory = await dshPackageDirectory(match[1], anchors)
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    return { title: typeof pkg.displayName === 'string' ? pkg.displayName : String(pkg.name || match[1]),
      packageName: String(pkg.name || match[1]), description: typeof pkg.description === 'string' ? pkg.description : '', version: String(pkg.version || '') }
  } catch { return }
}
