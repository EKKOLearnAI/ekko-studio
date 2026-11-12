import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertContracts } from './contracts.mjs'
import { checkSdk, guideNames } from './sdk.mjs'

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
export async function checkProject(root) {
  const config = await readJson(join(root, 'plugin.harness.json'))
  if (config.schemaVersion !== 1 || Object.keys(config).some(key => key !== 'schemaVersion')) throw new Error('Unsupported plugin.harness.json; use schemaVersion 1')
  const plugin = await readJson(join(root, 'plugin.json')), pkg = await readJson(join(root, 'package.json'))
  if (plugin.version !== pkg.version || plugin.apiVersion !== 1) throw new Error('Package/plugin versions must match and apiVersion must be 1')
  if (pkg.scripts?.['harness:check'] !== 'node scripts/plugin-harness.mjs check') throw new Error('Keep the generated harness:check command')
  assertContracts(await readJson(join(root, 'contracts/plugin.json')))
  await checkSdk(join(root, 'sdk'))
  for (const file of ['AGENTS.md', 'README.md', 'docs/CONTRACTS.md', ...guideNames.map(name => `docs/${name}`)]) {
    if (!(await readFile(join(root, file), 'utf8')).trim()) throw new Error(`Missing development document ${file}`)
  }
}
export async function runProjectCli(root, args) {
  try {
    if (args.length > 1 || args.length && args[0] !== 'check') throw new Error('Usage: plugin-harness.mjs check')
    await checkProject(root)
    console.log('Plugin documentation, declared fields and SDK files checked.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
