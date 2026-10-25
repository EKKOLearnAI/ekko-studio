import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function buildZcode(destination) {
  const root = fileURLToPath(new URL('../../..', import.meta.url)), source = join(root, 'plugins/zcode')
  await mkdir(destination, { recursive: true })
  await build({ entryPoints: [join(source, 'src/index.ts')], outfile: join(destination, 'dist/index.cjs'), platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true, logLevel: 'silent',
    alias: { '@ekko-studio/plugin-sdk': join(root, 'packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': join(root, 'packages/studio-agent-drivers/src/index.ts') } })
  for (const file of ['studio-plugin.json','package.json','README.md']) await copyFile(join(source,file),join(destination,file))
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildZcode(resolve('dist/plugins/zcode'))
