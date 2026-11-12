import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
export async function sources(root, prefix = '') {
  const result = {}
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Contract source must not be a symlink: ${path}`)
    if (entry.isDirectory()) Object.assign(result, await sources(root, path))
    else if (entry.isFile()) result[path] = (await readFile(join(root, path), 'utf8')).replace(/\r\n/g, '\n')
  }
  return result
}
export async function history(file) {
  const entries = await readJson(file).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (!Array.isArray(entries)) throw new Error(`Invalid change history: ${file}`)
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.summary !== 'string' || entry.summary.trim().length < 6 || typeof entry.compatibility !== 'string' || entry.compatibility.trim().length < 6) throw new Error('Each contract change needs a digest, summary and compatibility/migration explanation (at least 6 characters)')
  }
  return entries
}
export async function recordChange(file, digest, options) {
  const entries = await history(file)
  if (entries.at(-1)?.digest !== digest) {
    const { summary, compatibility } = options
    if (typeof summary !== 'string' || summary.trim().length < 6 || typeof compatibility !== 'string' || compatibility.trim().length < 6) throw new Error('Contract changed: supply --summary and --compatibility explaining the change and migration/default behavior (at least 6 characters each)')
    entries.push({ digest, summary: summary.trim(), compatibility: compatibility.trim() })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(entries, null, 2) + '\n')
  }
  return entries
}
export function renderHistory(entries) {
  return entries.map((entry, i) => `### ${i + 1}. ${entry.summary}\n\n兼容与迁移：${entry.compatibility}\n\n契约摘要：\`${entry.digest}\``).join('\n\n')
}
export async function expectDocument(file, expected) {
  if ((await readFile(file, 'utf8').catch(() => '')).replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) throw new Error(`Documentation is stale or missing: ${file}. Run the documented docs:update command; do not hand-edit generated references.`)
}
export function updateOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--summary', '--compatibility'].includes(args[i]) || !args[i + 1]) throw new Error('Use --summary "change description" --compatibility "compatibility and migration"')
    options[args[i].slice(2)] = args[i + 1]
  }
  return options
}
