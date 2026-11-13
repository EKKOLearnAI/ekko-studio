import { join, resolve } from 'path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { logger } from '../../../studio/public/logging'
import { safeFileStore, type MultiTextUpdate } from '../../../studio/public/safe-file-store'
import { getProfileDir, listProfileNamesFromDisk } from './profile'

function replaceDomain(value: string): string {
  const match = /^(\s*(?:https?:\/\/)?)(api\.apikey\.fun|apikey\.fun)(?=[:/?#]|\s*$)/i.exec(value)
  if (!match) return value
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== match[2].toLowerCase()) return value
  } catch {
    return value
  }
  return value.slice(0, match[1].length) + match[2].replace(/\.fun$/i, '.fan') + value.slice(match[0].length)
}

function replaceConfigDomains(raw: string): string {
  const doc = parseDocument(raw)
  // Do not log parser errors: their source excerpts can contain credentials.
  if (doc.errors.length) throw new Error('Invalid Hermes YAML configuration')
  if (!isMap(doc.contents)) return raw
  let changed = false
  const replaceEntry = (entry: unknown, fields = ['base_url', 'baseUrl']) => {
    if (!isMap(entry)) return
    for (const field of fields) {
      const node = entry.get(field, true)
      if (!isScalar(node) || typeof node.value !== 'string') continue
      const value = replaceDomain(node.value)
      if (value !== node.value) {
        node.value = value
        changed = true
      }
    }
  }
  const providerFields = ['base_url', 'baseUrl', 'url', 'api']
  replaceEntry(doc.get('model'))
  const customProviders = doc.get('custom_providers')
  if (isSeq(customProviders)) customProviders.items.forEach(entry => replaceEntry(entry, providerFields))
  const providers = doc.get('providers')
  if (isMap(providers)) providers.items.forEach(pair => replaceEntry(pair.value, providerFields))
  const auxiliary = doc.get('auxiliary')
  if (isMap(auxiliary)) auxiliary.items.forEach(pair => replaceEntry(pair.value))
  const fallbacks = doc.get('fallbacks')
  if (isSeq(fallbacks)) fallbacks.items.forEach(entry => replaceEntry(entry))
  return changed ? doc.toString() : raw
}

function replaceEnvDomains(raw: string): string {
  // Match URL settings only, preserving quoting, comments and line endings.
  // The separator after '=' stays spaces/tabs: \s would cross the newline of an
  // empty assignment and capture the following line as that key's value.
  return raw.replace(
    /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*BASE_URL\s*=[ \t]*)(["']?)([^\s"'#]+)(\2)(?=\s|#|$)/gm,
    (_match, prefix, quote, value, closingQuote) => `${prefix}${quote}${replaceDomain(value)}${closingQuote}`,
  )
}

export async function replaceHermesApiKeyDomains(): Promise<{ updatedProfiles: string[]; failedProfiles: string[] }> {
  const result = { updatedProfiles: [] as string[], failedProfiles: [] as string[] }
  for (const profile of listProfileNamesFromDisk()) {
    const dir = getProfileDir(profile)
    const configPath = resolve(join(dir, 'config.yaml'))
    const envPath = resolve(join(dir, '.env'))
    try {
      const changed = await safeFileStore.updateTexts([configPath, envPath], current => {
        const files: MultiTextUpdate = {}
        for (const [path, replace] of [[configPath, replaceConfigDomains], [envPath, replaceEnvDomains]] as const) {
          const raw = current[path]
          if (raw === undefined) continue
          const next = replace(raw)
          if (next !== raw) files[path] = next
        }
        return { files, result: Object.keys(files).length > 0 }
      }, { backup: true })
      if (changed) result.updatedProfiles.push(profile)
    } catch {
      result.failedProfiles.push(profile)
      logger.warn({ profile }, '[apikey-domain] could not replace old domains in Hermes configuration; will retry on next startup')
    }
  }
  return result
}
