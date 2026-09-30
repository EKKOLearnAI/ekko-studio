import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'

/** Read real published layouts so native integration tests cover both APIs. */
export async function dshReleaseFixture(command: string) {
  const require = createRequire(await realpath(command))
  let registry = false
  try { require.resolve('@deepseek-ai/dsh-agent-preset-registry/package.json'); registry = true } catch {}
  if (!registry) {
    const directory = dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json'))
    return { registry, standard: await readFile(join(directory, 'presets/standard/agent.cordis.yml'), 'utf8') }
  }
  const directory = dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const doc = parseDocument(await readFile(join(directory, 'presets/standard.patch.yml'), 'utf8'), { logLevel: 'silent' })
  const composition = doc.clone()
  composition.contents = doc.getIn([0, 'insert', 0, 'config', 'plugins'], true) as any
  return { registry, standard: String(composition) }
}
