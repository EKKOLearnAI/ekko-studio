import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

export type UpdateState = { autoUpdate: boolean; autoUpdateSupported?: boolean; checkedAt: string; currentVersion: string; latestVersion: string; status: 'unknown'|'checking'|'current'|'available'|'waiting'|'updating'|'failed'; error?: string }
export type UpdateAdapter = {
  ids(): string[]
  check(id: string): Promise<{success: boolean; tool: {installed: boolean; version: string}; latestVersion: string; updateAvailable: boolean; message?: string}>
  install(id: string): Promise<{success: boolean; tool: {version: string}; message?: string}>
  busy(id: string): boolean
  safelyManaged(id: string): boolean
  activityRevision(id: string): number
}
const blank = (): UpdateState => ({autoUpdate:false,checkedAt:'',currentVersion:'',latestVersion:'',status:'unknown'})
/** Only one scheduler owns checks; adapters must atomically exclude new launches
 * while installing. Policy is host-wide, never inherited from a chat prompt. */
export class AgentUpdatePolicy {
  private states: Record<string, UpdateState> = {}
  private preferences: Record<string, { autoUpdate: boolean }> = {}
  private checks = new Map<string, Promise<Awaited<ReturnType<UpdateAdapter['check']>>>>()
  private idle = new Map<string, { since: number; revision: number }>()
  private manualInstalls = new Set<string>()
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private writes: Promise<void> = Promise.resolve()
  constructor(private home: string, private adapter: UpdateAdapter, private filename = 'agent-update-policy.json') {}
  private state(id: string) { return this.states[id] ||= { ...blank(), autoUpdate: Boolean(this.preferences[id]?.autoUpdate) } }
  /** Discard checks belonging to an unloaded runtime, retaining its saved preference. */
  invalidate(id: string) { delete this.states[id]; this.checks.delete(id); this.idle.delete(id) }
  async load(): Promise<void> {
    try {
      const data=JSON.parse(await readFile(join(this.home,this.filename),'utf8'))
      for (const [id, value] of Object.entries(data)) if (value && typeof (value as any).autoUpdate === 'boolean' && /^[a-z][a-z0-9:._/-]*$/.test(id)) this.preferences[id] = { autoUpdate: (value as any).autoUpdate }
    } catch { /* absent or invalid policy fails closed to manual install */ }
  }
  snapshot(): Record<string, UpdateState> { return Object.fromEntries(this.adapter.ids().map(id=>[id,{...this.state(id), autoUpdate:this.state(id).autoUpdate && this.adapter.safelyManaged(id), autoUpdateSupported:this.adapter.safelyManaged(id)}])) }
  async set(id: string, enabled: unknown): Promise<void> {
    if(!this.adapter.ids().includes(id)||typeof enabled!=='boolean') throw new Error('Invalid agent update policy')
    if (enabled && !this.adapter.safelyManaged(id)) throw new Error('Automatic update is not supported for this installation; use manual update')
    this.idle.delete(id)
    Object.assign(this.state(id), {autoUpdate:enabled})
    this.preferences[id] = { autoUpdate: enabled }
    const value=JSON.stringify({ ...this.preferences, ...Object.fromEntries(Object.entries(this.states).map(([key,v])=>[key,{autoUpdate:v.autoUpdate}])) })
    this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.home,{recursive:true});const path=join(this.home,this.filename);await writeFile(path+'.tmp',value,{mode:0o600});await rename(path+'.tmp',path)})
    await this.writes
  }
  async installAndRefresh<T extends { success: boolean; tool: { version: string }; message?: string }>(id: string, install: () => Promise<T>): Promise<T & { updateState: UpdateState }> {
    if (!this.adapter.ids().includes(id)) throw new Error('Invalid agent update policy')
    if (this.manualInstalls.has(id) || this.states[id]?.status === 'updating') throw Object.assign(new Error('Agent update in progress'), { status: 409, code: 'AGENT_BUSY' })
    this.manualInstalls.add(id)
    this.idle.delete(id)
    try {
      // Drain an older check before mutation so it cannot overwrite the readback.
      await this.checks.get(id)?.catch(() => undefined)
      const state = this.state(id)
      state.status = 'updating'; state.error = undefined
      const result = await install()
      state.currentVersion = result.tool.version
      state.status = 'unknown'; state.checkedAt = ''
      if (result.success) {
        try { await this.checkNow(id, true) } catch { /* checkNow records failed/unknown freshness */ }
      } else { state.status = 'failed'; state.error = result.message || 'Install failed' }
      return { ...result, updateState: { ...state } }
    } catch (error) {
      const state = this.state(id)
      state.status = 'failed'; state.error = error instanceof Error ? error.message : 'Install failed'
      throw error
    } finally { this.manualInstalls.delete(id) }
  }

  start(): void { if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),60_000);this.timer.unref?.() }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=undefined }
  /** One check result shared by manual requests and scheduler; never install here. */
  async checkNow(id: string, afterInstall = false, check?: UpdateAdapter['check']): Promise<Awaited<ReturnType<UpdateAdapter['check']>>> {
    if (!this.adapter.ids().includes(id)) throw new Error('Invalid agent update policy')
    if (this.manualInstalls.has(id) && !afterInstall) throw new Error('Agent install in progress')
    const pending = this.checks.get(id)
    if (pending) return pending
    const state = this.state(id)
    if (state.status === 'updating') throw new Error('Agent update in progress')
    state.status = 'checking'
    state.error = undefined
    const job = Promise.resolve().then(() => check ? check(id) : this.adapter.check(id)).then(result => {
      state.checkedAt = new Date().toISOString()
      state.currentVersion = result.tool.version
      if (!result.success) {
        state.status = 'failed'
        state.error = result.message || 'Update check failed'
      } else {
        state.latestVersion = result.latestVersion
        state.status = result.tool.installed && result.updateAvailable ? 'available' : 'current'
        state.error = undefined
      }
      return result
    }).catch(error => {
      state.checkedAt = new Date().toISOString()
      state.status = 'failed'
      state.error = error instanceof Error ? error.message : 'Update check failed'
      throw error
    }).finally(() => { if (this.checks.get(id) === job) this.checks.delete(id) })
    this.checks.set(id, job)
    return job
  }

  async tick(force=false): Promise<void> {
    if(this.running)return;this.running=true
    try {
      for(const id of this.adapter.ids()) {
        if (!this.adapter.safelyManaged(id)) {
          this.idle.delete(id)
          continue
        }
        const state=this.state(id)
        try {
          if (this.manualInstalls.has(id)) continue
          const interval = state.status === 'failed' ? 5*60_000 : 6*60*60_000
          if(force||!state.checkedAt||Date.now()-Date.parse(state.checkedAt)>=interval) {
            const result = await this.checkNow(id)
            if (!result.success) continue
          }
          if (state !== this.state(id)) continue
          if (!state.autoUpdate || !this.adapter.safelyManaged(id) || !['available','waiting'].includes(state.status)) { this.idle.delete(id); continue }
          if (this.adapter.busy(id)) { this.idle.delete(id); state.status='waiting'; continue }
          const revision = this.adapter.activityRevision(id)
          let idle = this.idle.get(id)
          if (!idle || idle.revision !== revision) { idle={since:Date.now(),revision}; this.idle.set(id,idle) }
          if (Date.now()-idle.since < 60_000) { state.status='waiting'; continue }
          // No awaits between the final eligibility check and adapter lock acquisition.
          if (!state.autoUpdate || !this.adapter.safelyManaged(id) || this.adapter.busy(id) || this.adapter.activityRevision(id)!==revision) { this.idle.delete(id); continue }
          this.idle.delete(id)
          state.status='updating'
          const result=await this.adapter.install(id)
          if(!result.success)throw new Error(result.message||'Update failed')
          state.currentVersion=result.tool.version;state.status='unknown';state.checkedAt='';state.error=undefined
        } catch(error) {state.status='failed';state.error=error instanceof Error?error.message:'Update failed'}
      }
    } finally {this.running=false}
  }
}
