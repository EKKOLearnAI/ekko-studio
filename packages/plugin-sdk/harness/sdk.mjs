import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sources, hash, history, recordChange, renderHistory, expectDocument, updateOptions } from './documents.mjs'

export const guideNames = ['ARCHITECTURE.md', 'STUDIO_CTX.md', 'STUDIO_RETURNS.md', 'DEVELOPMENT.md']
export async function sdkInventory(root) {
  const pkg = await readJson(join(root, 'package.json'))
  return { version: pkg.version, sources: await sources(join(root, 'src')) }
}
function reference(inventory, entries) {
  const sections = Object.entries(inventory.sources).map(([path, text]) => `## src/${path}\n\n\`\`\`ts\n${text.trimEnd()}\n\`\`\``)
  return `# Studio Plugin SDK 结构参考\n\n由 SDK 源码生成，版本 ${inventory.version}。完整保留字段、可选性、返回类型与源码注释；语义说明见 STUDIO_CTX.md 和 STUDIO_RETURNS.md。\n\n${sections.join('\n\n')}\n\n## 契约变更记录\n\n${renderHistory(entries)}\n`
}
export async function checkSdk(root) {
  const inventory = await sdkInventory(root), digest = hash(inventory), entries = await history(join(root, 'docs/sdk-changes.json'))
  if (entries.at(-1)?.digest !== digest) throw new Error('Studio SDK contract changed without a change/compatibility explanation. Run npm run plugin-sdk:docs:update -- --summary "..." --compatibility "..." in Studio.')
  await expectDocument(join(root, 'docs/SDK_REFERENCE.md'), reference(inventory, entries))
  for (const name of guideNames) if (!(await readFile(join(root, 'docs', name), 'utf8')).trim()) throw new Error(`Missing SDK guide ${name}`)
  return digest
}
export async function updateSdk(root, options = {}) {
  const inventory = await sdkInventory(root)
  const entries = await recordChange(join(root, 'docs/sdk-changes.json'), hash(inventory), options)
  await writeFile(join(root, 'docs/SDK_REFERENCE.md'), reference(inventory, entries))
}
const self = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try {
    const root = resolve(dirname(self), '..'), action = process.argv[2] || 'check'
    if (action === 'update') await updateSdk(root, updateOptions(process.argv.slice(3)))
    else if (action === 'check') await checkSdk(root)
    else throw new Error('Usage: sdk.mjs check|update')
    console.log('Studio plugin SDK documentation is current.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
