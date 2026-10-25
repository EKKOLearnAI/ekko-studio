import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.STUDIO_CURSOR_COMMAND) throw new Error('Set STUDIO_CURSOR_COMMAND to the official Cursor executable')
const output = await mkdtemp(join(tmpdir(), 'studio-cursor-verify-'))
try {
  const plugin = join(output, 'plugin')
  await mkdir(join(plugin, 'dist'), { recursive: true })
  await build({ entryPoints: [join(root, 'plugins/cursor/src/index.ts')], outfile: join(plugin, 'dist/index.cjs'), platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true,
    alias: { '@ekko-studio/plugin-sdk': join(root, 'packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': join(root, 'packages/studio-agent-drivers/src/index.ts') } })
  for (const file of ['studio-plugin.json', 'package.json', 'README.md']) await cp(join(root, 'plugins/cursor', file), join(plugin, file))
  await build({ entryPoints: [join(root, 'packages/studio-plugin-runner/src/main.ts')], outfile: join(output, 'runner.cjs'), platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true })
  await build({ entryPoints: [join(root, 'tests/fixtures/cursor-plugin-native.ts')], outfile: join(output, 'verify.cjs'), platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true,
    alias: { '@ekko-studio/plugin-sdk': join(root, 'packages/studio-plugin-sdk/src/index.ts'), '@ekko-studio/agent-drivers': join(root, 'packages/studio-agent-drivers/src/index.ts') } })
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [join(output, 'verify.cjs'), output], { cwd: root, env: process.env, stdio: 'inherit' })
    child.on('error', reject); child.on('close', resolveCode)
  })
  if (code !== 0) throw new Error(`Cursor native boundary verification exited ${code}`)
} finally { await rm(output, { recursive: true, force: true }) }
