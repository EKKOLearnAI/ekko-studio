import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'js-yaml'
import { isDeepStrictEqual } from 'node:util'
import { safeFileStore } from '../../public/safe-file-store'
import { importAccountProviders, providerProfileDir, providerSourceDir } from './account-store'

export const supplementalSections = ['auxiliary', 'moa', 'fallback_providers', 'delegation'] as const
export type SupplementalSection = typeof supplementalSections[number]
export type EditMask = true | { [key: string]: EditMask }
export type SupplementalEdits = Partial<Record<SupplementalSection, EditMask>>
const editsPath = (profile: string) => join(providerProfileDir(profile), 'routing-edits.json')

function changed(before: any, after: any): EditMask | undefined {
  if (isDeepStrictEqual(before, after)) return undefined
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) !== Array.isArray(after)) return true
  // The settings of a model slot form one editable unit. Updating a timeout
  // or effort on that slot activates its gateway route as well.
  if ('provider' in after || 'model' in after || 'base_url' in after || 'api_key' in after) return true
  const mask: Record<string, EditMask> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const difference = changed(before[key], after[key])
    if (difference) mask[key] = difference
  }
  // Array length changes must retain the user's new ordering and deletions.
  if (Array.isArray(after) && before.length !== after.length) mask.length = true
  return mask
}

function mergeMask(before: EditMask | undefined, after: EditMask | undefined): EditMask | undefined {
  if (before === true || after === true) return true
  if (!after) return before
  const merged = { ...before }
  for (const [key, value] of Object.entries(after)) merged[key] = mergeMask(merged[key], value)!
  return merged
}

/** Apply only edited nodes; untouched Hermes configuration remains authoritative. */
export async function applySupplementalEdits(original: any, logical: any, mask: EditMask | undefined, project: (value: any) => Promise<any>): Promise<any> {
  if (!mask) return original
  if (mask === true) return project(logical)
  const result: any = Array.isArray(original) ? [...original] : { ...(original || {}) }
  for (const [key, node] of Object.entries(mask)) {
    if (Array.isArray(result) && key === 'length') continue
    if (logical?.[key] === undefined) delete result[key]
    else result[key] = await applySupplementalEdits(result[key], logical[key], node, project)
  }
  if (Array.isArray(result) && mask.length) result.length = logical.length
  return result
}

export async function readSupplementalEdits(profile: string): Promise<SupplementalEdits> {
  try { return JSON.parse(await safeFileStore.readText(editsPath(profile))) }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw error }
}

export async function supplementalConfigForDisplay(profile: string, owned: Record<string, any>): Promise<Record<string, any>> {
  const source = await safeFileStore.readYaml(join(providerSourceDir(profile), 'config.yaml'))
  const edits = await readSupplementalEdits(profile)
  const result = { ...owned }
  for (const section of supplementalSections) {
    delete result[section]
    const value = await applySupplementalEdits(source[section], owned[section], edits[section], async value => value)
    if (value !== undefined) result[section] = value
  }
  return result
}

/** Save the logical form and its edit mask atomically before projecting Hermes. */
export async function updateSupplementalConfig(profile: string, section: SupplementalSection, update: (current: any) => any): Promise<void> {
  await importAccountProviders()
  const path = join(providerProfileDir(profile), 'config.yaml')
  const editPath = editsPath(profile)
  await safeFileStore.updateTexts([path, editPath], async current => {
    const owned = (YAML.load(current[path] || '{}') || {}) as Record<string, any>
    const source = await safeFileStore.readYaml(join(providerSourceDir(profile), 'config.yaml'))
    const edits: SupplementalEdits = JSON.parse(current[editPath] || '{}')
    const before = await applySupplementalEdits(source[section], owned[section], edits[section], async value => value)
    const after = update(structuredClone(before))
    const mask = mergeMask(edits[section], changed(before, after))
    if (mask) edits[section] = mask
    if (after === undefined) delete owned[section]
    else owned[section] = after
    return { files: { [path]: YAML.dump(owned, { noRefs: true, lineWidth: -1 }), [editPath]: JSON.stringify(edits) }, result: undefined }
  }, { backup: true })
  await Promise.all([path, editPath].map(file => chmod(file, 0o600)))
}
