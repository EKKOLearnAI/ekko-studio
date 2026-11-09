import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DSH_ACP_ADAPTER_REVISION } from './acp-adapter'
import { DshPluginError } from './errors'

export interface DshInstallOptions { version?: string; rollback?: boolean }
interface Release { command: string; version: string; adapterRevision: number }
interface State { current?: Release; previous?: Release; pin?: string }
interface Host {
  resolveVersion(spec: string): Promise<string>
  install(prefix: string, version: string): Promise<void>
  preflight(command: string): Promise<void>
  existing(): Promise<{ command: string; version: string } | undefined>
}
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export function validateDshInstallOptions(input: DshInstallOptions): void {
  if (input.version !== undefined && (typeof input.version !== 'string' || (!exactVersion.test(input.version) && input.version !== 'latest'))) {
    throw Object.assign(new Error('DSH version must be an exact npm version or latest'), { status: 400 })
  }
  if (input.rollback !== undefined && typeof input.rollback !== 'boolean') throw Object.assign(new Error('rollback must be boolean'), { status: 400 })
  if (input.rollback && input.version !== undefined) throw Object.assign(new Error('Choose a version or rollback'), { status: 400 })
}

/** Release directories are immutable after validation. Only the small state file
 * is switched, so failed installs/probes cannot replace a working CLI or graph. */
export class DshManagedInstall {
  constructor(readonly root: string) {}
  private async read(): Promise<State> {
    try { return JSON.parse(await readFile(join(this.root, 'active.json'), 'utf8')) }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw error }
  }
  private async save(state: State): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const path = join(this.root, `active-${randomUUID()}.json`)
    try {
      await writeFile(path, JSON.stringify(state), { mode: 0o600 })
      await rename(path, join(this.root, 'active.json'))
    } finally { await rm(path, { force: true }) }
  }
  async info() {
    const state = await this.read()
    return { command: state.current?.command, pinnedVersion: state.pin || '',
      previousVersion: state.previous?.version || '', adapterRevision: DSH_ACP_ADAPTER_REVISION,
      verifiedVersion: state.current?.adapterRevision === DSH_ACP_ADAPTER_REVISION ? state.current.version : '' }
  }
  async install(options: DshInstallOptions, host: Host): Promise<void> {
    validateDshInstallOptions(options)
    const state = await this.read()
    if (options.rollback) {
      if (!state.previous) throw new DshPluginError(409, 'DSH_ROLLBACK_UNAVAILABLE', 'No previous compatible DSH installation is recorded; choose an exact version')
      await host.preflight(state.previous.command)
      await this.save({ current: { ...state.previous, adapterRevision: DSH_ACP_ADAPTER_REVISION }, previous: state.current, pin: state.previous.version })
      return
    }
    const spec = options.version || state.pin || 'latest'
    // Resolve once, then install that exact release; never race the latest tag.
    const version = await host.resolveVersion(spec)
    if (!exactVersion.test(version)) throw new Error('npm returned an invalid DSH version')
    await mkdir(join(this.root, 'releases'), { recursive: true })
    const prefix = await mkdtemp(join(this.root, 'releases', 'candidate-'))
    try {
      await host.install(prefix, version)
      const command = join(prefix, process.platform === 'win32' ? 'dsh.cmd' : 'bin/dsh')
      await host.preflight(command)
      let previous = state.current
      if (!previous) {
        // On first adoption, retain the external CLI too, but only advertise it
        // as a recovery target after the same compatibility check succeeds.
        const existing = await host.existing()
        if (existing) {
          try { await host.preflight(existing.command); previous = { ...existing, adapterRevision: DSH_ACP_ADAPTER_REVISION } }
          catch { /* A broken external installation is preserved, not certified. */ }
        }
      }
      await this.save({ current: { command, version, adapterRevision: DSH_ACP_ADAPTER_REVISION }, previous,
        pin: options.version === 'latest' ? undefined : options.version || state.pin })
    } catch (error: any) {
      await rm(prefix, { recursive: true, force: true })
      throw new DshPluginError(422, 'DSH_UPDATE_REJECTED', `DSH candidate was not activated; the previous installation was preserved. ${error.message}`)
    }
  }
  async clear(): Promise<void> { await rm(this.root, { recursive: true, force: true }) }
}
