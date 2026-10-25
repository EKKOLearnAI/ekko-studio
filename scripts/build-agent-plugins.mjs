import { build } from 'esbuild'
import { mkdir, readFile, copyFile, cp, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Build only implemented packages. Reservation of an ID does not install it.
export const agentPluginPackages = ['qwen-code', 'codex', 'kimi', 'qoder', 'codebuddy', 'copilot', 'opencode', 'pi', 'dsh', 'claude-code', 'antigravity', 'cursor', 'grok', 'zcode']

export async function buildAgentPlugins(outputRoot = resolve(root, 'dist/plugins')) {
  for (const name of agentPluginPackages) {
    const source = resolve(root, 'plugins', name)
    const destination = resolve(outputRoot, name)
    const manifest = JSON.parse(await readFile(join(source, 'studio-plugin.json'), 'utf8'))
    await mkdir(destination, { recursive: true })
    await build({
      entryPoints: [join(source, 'src/index.ts')], outfile: join(destination, manifest.backend),
      platform: 'node', target: 'node24.22.1', format: 'cjs', bundle: true, logLevel: 'silent',
      alias: {
        '@ekko-studio/plugin-sdk': resolve(root, 'packages/studio-plugin-sdk/src/index.ts'),
        '@ekko-studio/agent-drivers': resolve(root, 'packages/studio-agent-drivers/src/index.ts'),
      },
    })
    for (const file of ['studio-plugin.json', 'package.json', 'README.md']) await copyFile(join(source, file), join(destination, file))
    // Optional native extension assets are part of the same immutable plugin artifact.
    const native = join(source, 'native')
    const present = await stat(native).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (present) await cp(native, join(destination, 'native'), { recursive: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAgentPlugins()
