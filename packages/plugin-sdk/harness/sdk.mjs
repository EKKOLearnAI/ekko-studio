import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const guideNames = ['ARCHITECTURE.md', 'STUDIO_CTX.md', 'STUDIO_RETURNS.md', 'DEVELOPMENT.md']
export async function checkSdk(root) {
  for (const name of [...guideNames.map(name => `docs/${name}`), 'src/index.ts', 'src/agents.ts']) {
    if (!(await readFile(join(root, name), 'utf8')).trim()) throw new Error(`Missing SDK documentation or types: ${name}`)
  }
}
