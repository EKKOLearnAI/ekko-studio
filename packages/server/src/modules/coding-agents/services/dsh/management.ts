import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import { getWebUiHome } from '../../../studio/public/config'
import { DshPluginError } from './errors'
import { prepareDshManagementProfile } from './management-profile'
import { optionalDshFile } from './web-profile'

export interface DshManagementLaunch { installationCommand: string; sourceHome: string; launchPath?: string }
interface Host {
  runtimeInput(): Promise<DshManagementLaunch>
  commandEnv(): Promise<NodeJS.ProcessEnv>
  commandExecution(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean }
}
export interface DshUiTarget { endpoint: string; cookie: string; generation: string }
const instances = new Set<DshManagement>()
export async function shutdownDshManagement() { await Promise.all([...instances].map(instance => instance.close())) }

/** Owns a native Web process; its browser/RPC implementations remain native. */
export class DshManagement {
  private child?: ChildProcess
  private root = ''
  private target?: DshUiTarget
  private pending: Promise<unknown> = Promise.resolve()
  private idle?: ReturnType<typeof setTimeout>
  private fingerprint = ''
  constructor(private host: Host) { instances.add(this) }
  close(): Promise<void> {
    const task = this.pending.then(() => this.stop())
    this.pending = task.catch(() => {})
    return task
  }
  private async stop() {
    clearTimeout(this.idle)
    const child = this.child; this.child = undefined; this.target = undefined
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once('close', () => resolve()))
      await killOwnedProcessTree(child.pid, () => child.kill('SIGKILL'))
      await stopped
    }
    const root = this.root; this.root = ''
    if (root) await rm(root, { recursive: true, force: true })
  }
  touch(generation: string) {
    if (!this.target || this.target.generation !== generation || this.child?.exitCode !== null || this.child?.signalCode !== null) throw new DshPluginError(410, 'DSH_UI_EXPIRED', 'Reload the DSH configuration panel')
    clearTimeout(this.idle)
    this.idle = setTimeout(() => { void this.close() }, 15 * 60_000); this.idle.unref()
  }
  open(): Promise<DshUiTarget> {
    const task = this.pending.then(() => this.ensure())
    this.pending = task.catch(() => {})
    return task
  }
  private async ensure() {
    const input = await this.host.runtimeInput()
    const graph = await Promise.all(['profiles/web/package.json', 'profiles/web/cordis.patch.yml', 'cordis.patch.yml'].map(path => optionalDshFile(join(input.sourceHome, path))))
    const fingerprint = createHash('sha256').update(JSON.stringify([input.installationCommand, input.sourceHome, graph])).digest('hex')
    if (this.target && fingerprint === this.fingerprint && this.child?.exitCode === null && this.child?.signalCode === null) { this.touch(this.target.generation); return this.target }
    // Lifecycle operations serialize before replacing an owned process.
    const previous = this.child; this.child = undefined; this.target = undefined
    if (previous?.pid && previous.exitCode === null && previous.signalCode === null) {
      const stopped = new Promise<void>(resolve => previous.once('close', () => resolve()))
      await killOwnedProcessTree(previous.pid, () => previous.kill('SIGKILL')); await stopped
    }
    if (this.root) await rm(this.root, { recursive: true, force: true })
    const directory = join(getWebUiHome(), 'coding-agents/dsh/management')
    await mkdir(directory, { recursive: true }); await mkdir(input.sourceHome, { recursive: true })
    this.root = await mkdtemp(join(directory, 'host-'))
    this.fingerprint = fingerprint
    const prepared = await prepareDshManagementProfile({ command: input.installationCommand, sourceHome: input.sourceHome, rootDir: this.root })
    const execution = this.host.commandExecution(input.installationCommand, ['--profile', prepared.profile, '--patch', prepared.patch, '--host', '127.0.0.1', '--port', '0', '--no-open'])
    const child = spawn(execution.command, execution.args, { cwd: input.sourceHome, detached: process.platform !== 'win32', windowsHide: true,
      ...(execution.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: { ...await this.host.commandEnv(), DSH_HOME: this.root, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    try {
      const target = await new Promise<DshUiTarget>((resolve, reject) => {
        let output = ''; let settled = false; let probing = false
        const timeout = setTimeout(() => fail('readiness timed out after 30 seconds'), 30_000)
        function fail(reason: string) { if (!settled) { settled = true; clearTimeout(timeout); reject(new DshPluginError(503, 'DSH_UI_UNAVAILABLE', `Unable to start the DSH configuration runtime (${reason})`)) } }
        child.once('error', (error: NodeJS.ErrnoException) => {
          // Only expose OS error identifiers, never command paths or plugin logs.
          const code = error.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? `: ${error.code}` : ''
          fail(`process launch failed${code}`)
        })
        child.once('close', code => fail(`process exited before readiness${typeof code === 'number' ? `: ${code}` : ''}`))
        child.stderr?.resume() // Native plugins may log private configuration.
        child.stdout?.on('data', chunk => {
          output = (output + String(chunk)).slice(-4096)
          const found = output.match(/STUDIO_DSH_UI_READY:(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
          if (!found || settled || probing) return
          probing = true
          let stage = 'native connection'
          void (async () => {
            const endpoint = new URL(found[1]).origin
            const exchange = await fetch(found[1], { redirect: 'manual', signal: AbortSignal.timeout(5000) })
            stage = 'native authentication'
            const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
            await exchange.body?.cancel()
            if (exchange.status !== 303 || !cookie) { fail(`native authentication failed (HTTP ${exchange.status})`); return }
            stage = 'native frontend probe'
            const probe = await fetch(endpoint, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
            if (!probe.ok) throw new Error('Native frontend unavailable')
            await probe.body?.cancel()
            if (!settled) { settled = true; clearTimeout(timeout); resolve({ endpoint, cookie, generation: randomUUID() }) }
          })().catch(error => {
            // A native process may announce its URL before plugin activation
            // fails. A refused connection is not an authentication rejection.
            const code = error?.cause?.code
            const detail = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) ? `: ${code}` : ''
            fail(`${stage} failed${detail}`)
          })
        })
      })
      this.target = target; this.touch(target.generation); return target
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) await killOwnedProcessTree(child.pid, () => child.kill('SIGKILL'))
      throw error
    }
  }
}
