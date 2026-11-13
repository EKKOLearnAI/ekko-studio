import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { DshPluginError } from './errors'

/** Native bundles may compose one patch or an ordered list of patches. */
export async function readDshBundlePatches(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const value = manifest.dsh?.bundle?.patch
  const paths = typeof value === 'string' ? [value] : value
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path.trim())) {
    throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', `Web bundle ${manifest.name || directory} has no composition patch`)
  }
  return Promise.all(paths.map(async (path: string) => ({ path: join(directory, path), content: await readFile(join(directory, path), 'utf8') })))
}

/** Detect the native registry from composition, not a CLI version allowlist. */
export function usesDshPresetRegistry(layers: string[]) {
  return layers.some(content => {
    const document = parseDocument(content, { logLevel: 'silent' })
    if (!isSeq(document.contents)) return false
    return document.contents.items.some(patch => {
      const insert = isMap(patch) ? patch.get('insert', true) : undefined
      return isSeq(insert) && insert.items.some(row => isMap(row) && row.get('name') === '@deepseek-ai/dsh-agent-preset-registry')
    })
  })
}
