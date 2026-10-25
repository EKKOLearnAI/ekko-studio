import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nativeAgentSetup, StudioError, type AgentCliInstallPlan, type AgentNativeCli, type AgentProviderRef, type AgentRuntimeContext, type ProcessSpawnInput } from '../../contracts/plugins'
import type { AgentInstance } from '../../repositories/agent-execution-store'
import { parseAgentCliInstall } from './cli-install-contract'

type Identity = Pick<AgentInstance, 'id' | 'ownerId' | 'profileId'>
interface Pointer { schemaVersion: 1; provider: string; platform: string; arch: string; directory: string; plan: AgentCliInstallPlan }
export interface CliInstallStage { launch: ProcessSpawnInput; verify(context: AgentRuntimeContext): Promise<void>; publish(): void; discard(): Promise<void> }
const inside = (parent: string, child: string) => { const path = relative(parent, child); return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
const providerKey = (provider: AgentProviderRef) => JSON.stringify(provider.kind === 'plugin'
  ? ['plugin', provider.pluginId, provider.version] : ['builtin', provider.module, provider.implementationVersion])

/** Private installations survive configuration/mode changes. Only an atomic pointer selects a verified version. */
export class AgentCliInstallations {
  constructor(private readonly root: string, private readonly npm = npmExecution) {}
  private directory(instance: Identity): string {
    return resolve(this.root, 'native-cli', createHash('sha256').update(JSON.stringify([instance.ownerId, instance.profileId, instance.id])).digest('hex'))
  }
  load(instance: Identity, provider: AgentProviderRef): AgentNativeCli | undefined {
    const directory = this.directory(instance), path = join(directory, 'current.json')
    try {
      let info
      try { info = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
      if (!info.isFile() || info.size > 4096) throw new Error('Invalid CLI metadata')
      const pointer = JSON.parse(readFileSync(path, 'utf8')) as Pointer
      if (pointer.schemaVersion !== 1 || pointer.provider !== providerKey(provider) || pointer.platform !== process.platform || pointer.arch !== process.arch
        || typeof pointer.directory !== 'string' || !/^[0-9a-f-]{36}$/.test(pointer.directory)) throw new Error('CLI identity changed')
      const prefix = join(directory, pointer.directory)
      if (!inside(realpathSync(directory), realpathSync(prefix))) throw new Error('CLI storage changed')
      return this.verify(prefix, parseAgentCliInstall(pointer.plan))
    } catch { return { state: 'unavailable' } }
  }

  async stage(instance: Identity, provider: AgentProviderRef, value: AgentCliInstallPlan, authorize: () => void): Promise<CliInstallStage> {
    const plan = parseAgentCliInstall(value), tool = this.npm(), directory = this.directory(instance), id = randomUUID(), prefix = join(directory, id)
    authorize()
    await mkdir(prefix, { recursive: true, mode: 0o700 })
    let published = false
    const discard = async () => { if (!published) await rm(prefix, { recursive: true, force: true }) }
    try {
      await chmod(directory, 0o700)
      const home = join(prefix, '.installer'), userconfig = join(home, 'npmrc'), globalconfig = join(home, 'global-npmrc')
      await mkdir(home, { mode: 0o700 })
      await Promise.all([writeFile(userconfig, '', { mode: 0o600, flag: 'wx' }), writeFile(globalconfig, '', { mode: 0o600, flag: 'wx' })])
      authorize()
      const env: Record<string, string> = { HOME: home, USERPROFILE: home, NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
        NPM_CONFIG_CACHE: join(home, 'cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_GLOBAL: 'false' }
      if (plan.nativeHomeEnv?.length) {
        const nativeHome = join(home, 'native')
        await mkdir(nativeHome, { mode: 0o700 })
        for (const name of plan.nativeHomeEnv) env[name] = nativeHome
      }
      return {
        launch: { ...tool, args: [...tool.args, 'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true',
          '--registry=https://registry.npmjs.org/', ...(plan.preferDedupe ? ['--prefer-dedupe'] : []), '--', `${plan.packageName}@${plan.version}`], cwd: home,
          env },
        verify: async context => {
          authorize()
          const cli = this.verify(prefix, plan)
          // Reuse the bounded, version-only probe with an explicit command, before selecting this installation.
          const result = await nativeAgentSetup(cli.command, `${plan.packageName}@${plan.version}`, [])({ instanceId: instance.id, configRevision: 1,
            mode: 'scoped', config: { command: cli.command, args: cli.args, cwd: home, env } }, context)
          if (result.cli.state !== 'available' || result.cli.version !== plan.version) throw new StudioError('RUNTIME_UNAVAILABLE', 'Installed CLI version probe failed')
          authorize()
        },
        publish: () => {
          authorize()
          this.verify(prefix, plan)
          const pointer: Pointer = { schemaVersion: 1, provider: providerKey(provider), platform: process.platform, arch: process.arch, directory: id, plan }
          const temporary = join(directory, `.current-${randomUUID()}.json`)
          try {
            writeFileSync(temporary, JSON.stringify(pointer), { mode: 0o600, flag: 'wx' })
            authorize()
            renameSync(temporary, join(directory, 'current.json'))
            published = true
          } finally { rmSync(temporary, { force: true }) }
        }, discard,
      }
    } catch (error) { await discard(); throw error }
  }

  private verify(prefix: string, plan: AgentCliInstallPlan): Extract<AgentNativeCli, { state: 'ready' }> {
    const root = realpathSync(prefix), packageRoot = realpathSync(join(prefix, 'node_modules', ...plan.packageName.split('/')))
    if (!inside(root, packageRoot)) throw new StudioError('RUNTIME_UNAVAILABLE', 'Installed CLI escaped private storage')
    const manifestPath = join(packageRoot, 'package.json')
    if (statSync(manifestPath).size > 1_048_576) throw new StudioError('RUNTIME_UNAVAILABLE', 'Installed CLI metadata is too large')
    const metadata = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bin = typeof metadata.bin === 'string' ? (plan.bin === plan.packageName.split('/').at(-1) ? metadata.bin : undefined) : metadata.bin?.[plan.bin]
    if (metadata.name !== plan.packageName || metadata.version !== plan.version || typeof bin !== 'string' || !bin || isAbsolute(bin)) throw new StudioError('RUNTIME_UNAVAILABLE', 'Installed CLI does not match the declared version')
    const executable = realpathSync(resolve(packageRoot, bin))
    if (!inside(packageRoot, executable) || !statSync(executable).isFile()) throw new StudioError('RUNTIME_UNAVAILABLE', 'Installed CLI entry is unavailable')
    return plan.runner === 'node' ? { state: 'ready', command: process.execPath, args: [executable] } : { state: 'ready', command: executable, args: [] }
  }
}

/** Run npm's JS entry with the current host runtime, including packaged Electron helpers. */
export function npmExecution(): { command: string; args: string[] } {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  for (const entry of (process.env.PATH || '').split(delimiter)) {
    if (!entry) continue
    for (const name of process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm']) {
      try {
        const bin = realpathSync(join(entry, name))
        candidates.push(bin.endsWith('npm-cli.js') ? bin : join(dirname(bin), 'node_modules/npm/bin/npm-cli.js'), join(dirname(bin), '../lib/node_modules/npm/bin/npm-cli.js'))
      } catch { /* Continue through host toolchain candidates. */ }
    }
  }
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !candidate.endsWith(`${sep}npm-cli.js`)) continue
    try { if (statSync(candidate).isFile()) return { command: process.execPath, args: [realpathSync(candidate)] } } catch { /* Try the next host candidate. */ }
  }
  throw new StudioError('CAPABILITY_UNSUPPORTED', 'npm is unavailable; install the native CLI using the displayed instructions')
}
