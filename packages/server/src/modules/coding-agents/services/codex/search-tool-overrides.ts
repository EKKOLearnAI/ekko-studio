import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

/** Only provider-scoped configuration opts into this compatibility override.
 * A global catalog cannot identify which provider needs a model workaround.
 */
export async function codexSearchToolOverrides(
  scopedContent: string | null | undefined,
  model: string,
  configHome: string,
): Promise<Map<string, boolean>> {
  const overrides = new Map<string, boolean>()
  if (!scopedContent?.trim()) return overrides
  const configuredPath = parseToml(scopedContent).model_catalog_json
  if (configuredPath === undefined) return overrides
  if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
    throw new Error('Provider-scoped model_catalog_json must be a non-empty absolute path')
  }
  const path = configuredPath.trim()
  const catalogPath = path === '~' ? configHome : path.startsWith('~/') ? join(configHome, path.slice(2)) : path
  if (!isAbsolute(catalogPath)) throw new Error('Provider-scoped model_catalog_json must be an absolute path')
  try {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf-8'))
    if (!Array.isArray(catalog.models)) throw new Error('expected a models array')
    const entries = catalog.models.filter((entry: any) => entry?.slug === model)
    if (entries.length > 1) throw new Error(`duplicate catalog entries for model ${model}`)
    const capability = entries[0]?.supports_search_tool
    if (capability !== undefined) {
      if (typeof capability !== 'boolean') throw new Error(`supports_search_tool for model ${model} must be boolean`)
      overrides.set(model, capability)
    }
    return overrides
  } catch (cause) {
    throw new Error(`Cannot load provider-scoped Codex model catalog ${catalogPath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}
