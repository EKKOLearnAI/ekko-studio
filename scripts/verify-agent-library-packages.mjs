import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packAgentLibraries } from './pack-agent-libraries.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(join(tmpdir(), 'studio-public-sdk-consumer-'))
const npm = process.env.npm_execpath
const env = { ...process.env }
delete env.NODE_PATH
try {
  const artifacts = packAgentLibraries(root, join(directory, 'artifacts'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'external-studio-plugin', private: true, type: 'commonjs' }))
  const development = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies
  execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
    ...artifacts.map(artifact => join(directory, 'artifacts', artifact.filename)),
    `typescript@${development.typescript}`, `@types/node@${development['@types/node']}`], { cwd: directory, env, stdio: 'inherit' })
  writeFileSync(join(directory, 'plugin.ts'), `
import { StudioError, type StudioPlugin, type AgentRuntime } from '@ekko-studio/plugin-sdk'
import { createAcpRuntime, acpCommands, AcpRequestError } from '@ekko-studio/agent-drivers'
export const apply: StudioPlugin['apply'] = plugin => {
  plugin.agents.register({ id: 'external-agent', name: 'External Agent',
    configSchema: { type: 'object' }, capabilities: { text: true, modes: ['global'] },
    async create(input, context): Promise<AgentRuntime> {
      return createAcpRuntime(input, context, { name: 'External', command: 'external-agent', args: ['acp'] })
    },
  })
}
if (acpCommands([], { pluginId: 'external.plugin', agentTypeId: 'external-agent', name: 'External' }).length) throw new Error('Unexpected commands')
if (typeof AcpRequestError !== 'function') throw new Error('Missing protocol export')
try {
  createAcpRuntime({ mode: 'scoped', config: { cwd: '/tmp' } } as any, {} as any, { name: 'External', command: 'external-agent', args: [] })
  throw new Error('Missing validation')
} catch (error) {
  if (!(error instanceof StudioError) || error.code !== 'CAPABILITY_UNSUPPORTED') throw error
}
console.log('External SDK/driver consumer compiled and loaded; shared StudioError identity preserved')
`)
  execFileSync(process.execPath, [join(directory, 'node_modules/typescript/bin/tsc'), 'plugin.ts', '--target', 'ES2022',
    '--module', 'Node16', '--moduleResolution', 'Node16', '--strict', '--types', 'node', '--outDir', 'dist'], { cwd: directory, env, stdio: 'inherit' })
  execFileSync(process.execPath, [join(directory, 'dist/plugin.js')], { cwd: directory, env, stdio: 'inherit' })
  console.log(JSON.stringify({ artifacts, consumer: 'outside repository', verified: true }, null, 2))
} finally { rmSync(directory, { recursive: true, force: true }) }
