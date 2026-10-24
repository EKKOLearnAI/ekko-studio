import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [resolve(root, 'packages/studio-plugin-runner/src/main.ts')],
  outfile: resolve(root, 'dist/server/plugin-runner.cjs'),
  platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true, sourcemap: true, logLevel: 'info',
})
