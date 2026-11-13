import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { PluginIdentity } from '../../contracts/plugins'
import { windowsCmdShimExecution } from '../../public/windows-command'
import { PluginManager } from './manager'
import { PluginError, message } from './errors'
import { identifier, manifest } from './schema'
import { readManifest } from './installer'

interface Project { schema: 1; id: string; directory: string; createdAt: number }
interface Progress { fingerprint?: string; pending?: string; building?: boolean; error?: string; updatedAt?: number }
// Source projects can use any bundler. Output and dependency trees never trigger a rebuild.
const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.DS_Store'])
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256'); let count = 0
  async function visit(root: string) {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
      if (++count > 20_000) throw new PluginError('Development project exceeds 20000 source entries; keep generated files in dist or build')
      const file = join(root, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) { const info = await stat(file); hash.update(JSON.stringify([file, info.size, info.mtimeMs, info.ctimeMs])) }
    }
  }
  await visit(directory)
  return hash.digest('hex')
}
async function build(directory: string, signal: AbortSignal): Promise<void> {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const hasHarness = await stat(join(directory, 'plugin.harness.json')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error })
  if (hasHarness && pkg.scripts?.['harness:check'] !== 'node scripts/plugin-harness.mjs check') throw new PluginError('Development harness:check command is missing or changed', 'PLUGIN_BUILD', 422)
  if (pkg.scripts?.['harness:check']) await runBuildScript(directory, 'harness:check', signal)
  if (pkg.scripts?.build) {
    await runBuildScript(directory, 'build', signal)
    if (pkg.scripts?.['harness:check']) await runBuildScript(directory, 'harness:check', signal)
  }
}
async function runBuildScript(directory: string, script: string, signal: AbortSignal): Promise<void> {
  const args = ['run', script], npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const command = process.platform === 'win32' ? windowsCmdShimExecution(npm, args) : { command: npm, args }
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { cwd: directory, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...('windowsVerbatimArguments' in command ? { windowsVerbatimArguments: true } : {}),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let output = '', bytes = 0, failure = ''
    const stop = (reason: string) => {
      if (failure) return
      failure = reason
      if (!child.pid) return
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { child.kill() })
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const abort = () => stop('Plugin build cancelled')
    const timeout = setTimeout(() => stop('Plugin build exceeded 120 seconds'), 120_000)
    const receive = (chunk: Buffer) => {
      bytes += chunk.length; output = (output + chunk.toString('utf8')).slice(-4000)
      if (bytes > 2 * 1024 * 1024) stop('Plugin build output exceeds 2 MB')
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', code => {
      cleanup()
      if (failure || code !== 0) reject(new PluginError(failure || `Plugin build failed: ${output || `exit ${code}`}`, 'PLUGIN_BUILD', 422))
      else resolve()
    })
  })
}

/** The CLI only registers directories. Executing a project requires administrator activation. */
export class PluginDevelopment {
  private progress = new Map<string, Progress>()
  private jobs = new Map<string, Promise<void>>()
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private polling?: Promise<void>
  constructor(private manager: PluginManager, private authorize: (identity: PluginIdentity) => void | Promise<void>, private changed: () => Promise<void> = async () => {}) {}
  private get directory() { return join(this.manager.store.home, 'development') }
  private async project(id: string): Promise<Project> {
    identifier(id)
    const project = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'))
    if (project.schema !== 1 || project.id !== id || typeof project.directory !== 'string' || !isAbsolute(project.directory)) throw new PluginError('Invalid development registration')
    if (await realpath(project.directory) !== project.directory) throw new PluginError('Development directory moved; register it again')
    const definition = manifest(JSON.parse(await readFile(join(project.directory, 'plugin.json'), 'utf8')))
    if (definition.id !== id) throw new PluginError('Development manifest id changed; register it again')
    return project
  }
  async list() {
    const names = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const records = this.manager.store.read().records
    const projects = await Promise.all(names.filter(name => /^[a-z][a-z0-9._-]{0,79}\.json$/.test(name)).sort().map(async name => {
      const id = name.slice(0, -5), progress = this.progress.get(id)
      try {
        const project = await this.project(id), record = records[id]
        const watching = !!record?.enabled && record.developmentDirectory === project.directory
        return { ...project, manifest: await readManifest(project.directory, { validateEntries: false }), watching, status: progress?.building ? 'building' : progress?.error ? 'error' : watching ? 'watching' : 'registered', error: progress?.error, updatedAt: progress?.updatedAt }
      } catch (error) {
        const registered = await readFile(join(this.directory, name), 'utf8').then(text => JSON.parse(text)).catch(() => ({}))
        return { id, directory: typeof registered.directory === 'string' ? registered.directory : '', manifest: records[id]?.manifest, watching: false, status: 'missing', error: message(error) }
      }
    }))
    return { directory: this.directory, projects }
  }
  async unlink(identity: PluginIdentity, id: string, revision: number): Promise<void> {
    await this.authorize(identity)
    identifier(id)
    const file = join(this.directory, `${id}.json`)
    await stat(file)
    const state = this.manager.store.read()
    if (!Number.isSafeInteger(revision) || state.revision !== revision) throw new PluginError('Plugin settings changed; reload before saving', 'PLUGIN_REVISION', 409)
    if (state.records[id]?.developmentDirectory) await this.manager.update(identity, id, revision, { action: 'stop-development' })
    await unlink(file)
    this.progress.delete(id)
    await this.changed()
  }
  async start(identity: PluginIdentity, id: string, revision: number): Promise<void> {
    await this.authorize(identity)
    if (this.controller.signal.aborted) throw new PluginError('Plugin development host is stopped')
    if (this.jobs.has(id)) throw new PluginError('Plugin build is already running', 'PLUGIN_BUILD_BUSY', 409)
    const project = await this.project(id)
    if (this.jobs.has(id)) throw new PluginError('Plugin build is already running', 'PLUGIN_BUILD_BUSY', 409)
    if (this.manager.store.read().revision !== revision) throw new PluginError('Plugin settings changed; reload before saving', 'PLUGIN_REVISION', 409)
    return this.rebuild(identity, project, revision)
  }
  private rebuild(identity: PluginIdentity, project: Project, revision: number): Promise<void> {
    const progress: Progress = this.progress.get(project.id) || {}
    progress.building = true; progress.error = undefined; this.progress.set(project.id, progress)
    let attempted: string | undefined
    const job = (async () => {
      try {
        await this.authorize(identity)
        const before = attempted = await fingerprint(project.directory)
        await build(project.directory, this.controller.signal)
        this.controller.signal.throwIfAborted()
        await this.authorize(identity)
        if ((await this.project(project.id)).directory !== project.directory) throw new PluginError('Development registration changed during build')
        const state = this.manager.store.read()
        // Install checks the captured revision: disabling/uninstalling during a build wins.
        await this.manager.install(identity, project.directory, revision, project.id, { developmentDirectory: project.directory, enabled: true })
        progress.fingerprint = before; progress.pending = undefined; progress.updatedAt = Date.now()
        await this.changed()
        // Retain current and previous snapshots, not one package directory per keystroke.
        const obsolete = state.records[project.id]?.previous
        if (obsolete?.developmentDirectory === project.directory) await this.manager.pruneDevelopmentPackage(obsolete.directory)
      } catch (error) {
        progress.error = message(error)
        if (!(error instanceof PluginError && error.code === 'PLUGIN_REVISION')) {
          // Retry a failed build on the next source change or explicit Start action.
          progress.fingerprint = attempted
        }
        throw error
      } finally { progress.building = false }
    })()
    this.jobs.set(project.id, job)
    return job.finally(() => { this.jobs.delete(project.id) })
  }
  async tick(): Promise<void> {
    if (this.controller.signal.aborted) return
    for (const record of Object.values(this.manager.store.read().records)) {
      const id = record.manifest.id
      if (!record.enabled || !record.developmentDirectory || !record.runtimeIdentity || this.jobs.has(id)) continue
      const progress = this.progress.get(id) || {}; this.progress.set(id, progress)
      try {
        const project = await this.project(id)
        if (project.directory !== record.developmentDirectory) throw new PluginError('Registered directory changed; start debugging again')
        await this.authorize(record.runtimeIdentity)
        const current = await fingerprint(project.directory)
        if (current === progress.fingerprint) continue
        // Two stable observations debounce saves and avoid building partial editor writes.
        if (current !== progress.pending) { progress.pending = current; continue }
        const state = this.manager.store.read(), latest = state.records[id]
        if (!latest?.enabled || latest.developmentDirectory !== project.directory) continue
        await this.rebuild(record.runtimeIdentity, project, state.revision)
      } catch (error) { progress.error = message(error) }
    }
  }
  watch() {
    if (this.timer || this.polling || this.controller.signal.aborted) return
    const poll = () => {
      this.timer = undefined
      this.polling = this.tick().catch(() => {}).finally(() => {
        this.polling = undefined
        if (!this.controller.signal.aborted) { this.timer = setTimeout(poll, 1000); this.timer.unref() }
      })
    }
    poll()
  }
  async close() {
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    await Promise.allSettled([...this.jobs.values(), ...(this.polling ? [this.polling] : [])])
  }
}
