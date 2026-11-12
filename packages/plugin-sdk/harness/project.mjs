import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertContracts } from './contracts.mjs'
import { readJson, canonical, hash, history, recordChange, renderHistory, expectDocument, updateOptions } from './documents.mjs'
import { checkSdk, guideNames } from './sdk.mjs'

export async function projectInventory(root) {
  const config = await readJson(join(root, 'plugin.harness.json'))
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => key !== 'schemaVersion')) throw new Error('Unsupported plugin.harness.json; use schemaVersion 1')
  const plugin = await readJson(join(root, 'plugin.json')), pkg = await readJson(join(root, 'package.json'))
  if (plugin.version !== pkg.version || plugin.apiVersion !== 1) throw new Error('Package/plugin versions must match and apiVersion must be 1')
  if (pkg.scripts?.['harness:check'] !== 'node scripts/plugin-harness.mjs check' || pkg.scripts?.['docs:update'] !== 'node scripts/plugin-harness.mjs update') throw new Error('Keep the generated harness:check and docs:update commands')
  const contract = assertContracts(await readJson(join(root, 'contracts/plugin.json')))
  const sdkDigest = await checkSdk(join(root, 'sdk'))
  // Track declared plugin schemas, manifest/configuration shapes and the actual bundled SDK.
  return canonical({ plugin, contract, sdkDigest })
}
function reference(inventory, entries) {
  const sections = Object.entries(inventory.contract).filter(([key]) => !['schemaVersion', 'description'].includes(key))
    .map(([key, value]) => `## ${key}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``)
  return `# 插件数据契约\n\n${inventory.contract.description}\n\n此文件由 contracts/plugin.json 与 plugin.json 生成。每个字段的说明属于契约，不能只改类型而省略语义。\n\nSDK 契约：\`${inventory.sdkDigest}\`\n\n## 插件清单\n\n\`\`\`json\n${JSON.stringify(inventory.plugin, null, 2)}\n\`\`\`\n\n${sections.join('\n\n')}\n\n## 变更与迁移\n\n${renderHistory(entries)}\n`
}
export async function checkProject(root) {
  const inventory = await projectInventory(root), digest = hash(inventory), entries = await history(join(root, 'contracts/changes.json'))
  if (entries.at(-1)?.digest !== digest) throw new Error('Plugin data contract changed without documentation. Update field descriptions, then run npm run docs:update -- --summary "..." --compatibility "...".')
  await expectDocument(join(root, 'docs/CONTRACTS.md'), reference(inventory, entries))
  for (const file of ['AGENTS.md', 'README.md', ...guideNames.map(name => `docs/${name}`)]) if (!(await readFile(join(root, file), 'utf8')).trim()) throw new Error(`Missing development document ${file}`)
  for (const name of guideNames) await expectDocument(join(root, 'docs', name), await readFile(join(root, 'sdk/docs', name), 'utf8'))
  return inventory
}
export async function updateProject(root, options = {}) {
  const inventory = await projectInventory(root)
  const entries = await recordChange(join(root, 'contracts/changes.json'), hash(inventory), options)
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs/CONTRACTS.md'), reference(inventory, entries))
  // Copy canonical guides alongside the project-specific contract reference.
  for (const name of guideNames) await writeFile(join(root, 'docs', name), await readFile(join(root, 'sdk/docs', name), 'utf8'))
}
export async function runProjectCli(root, args) {
  try {
    const [action = 'check', ...options] = args
    if (action === 'update') await updateProject(root, updateOptions(options))
    else if (action === 'check' && !options.length) await checkProject(root)
    else throw new Error('Usage: plugin-harness.mjs check|update --summary "..." --compatibility "..."')
    console.log('Plugin contracts, SDK reference and development documents are current.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
