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
  private checks = new Map<string, Promise<Awaited<ReturnType<UpdateAdapter['check']>>>>()
  private idle = new Map<string, { since: number; revision: number }>()
  private manualInstalls = new Set<string>()
  private running = false
  private timer?: ReturnType<typeof setInterval>
  private writes: Promise<void> = Promise.resolve()
  constructor(private home: string, private adapter: UpdateAdapter) {}
  async load(): Promise<void> {
    try {
      const data=JSON.parse(await readFile(join(this.home,'agent-update-policy.json'),'utf8'))
      for(const id of this.adapter.ids()) if(typeof data[id]?.autoUpdate==='boolean') this.states[id]={...blank(),autoUpdate:data[id].autoUpdate && this.adapter.safelyManaged(id)}
    } catch { /* absent or invalid policy fails closed to manual install */ }
  }
  snapshot(): Record<string, UpdateState> { return Object.fromEntries(this.adapter.ids().map(id=>[id,{...(this.states[id]||blank()), autoUpdateSupported:this.adapter.safelyManaged(id)}])) }
  async set(id: string, enabled: unknown): Promise<void> {
    if(!this.adapter.ids().includes(id)||typeof enabled!=='boolean') throw new Error('Invalid agent update policy')
    if (enabled && !this.adapter.safelyManaged(id)) throw new Error('Automatic update is not supported for this installation; use manual update')
    this.idle.delete(id)
    Object.assign(this.states[id] ||= blank(), {autoUpdate:enabled})
    const value=JSON.stringify(Object.fromEntries(Object.entries(this.states).map(([key,v])=>[key,{autoUpdate:v.autoUpdate}])))
    this.writes=this.writes.catch(()=>{}).then(async()=>{await mkdir(this.home,{recursive:true});const path=join(this.home,'agent-update-policy.json');await writeFile(path+'.tmp',value,{mode:0o600});await rename(path+'.tmp',path)})
    await this.writes
  }
  async installAndRefresh<T extends { success: boolean; tool: { version: string }; message?: string }>(id: string, install: () => Promise<T>): Promise<T & { updateState: UpdateState }> {
    if (!this.adapter.ids().includes(id)) throw new Error('Invalid agent update policy')
    if (this.manualInstalls.has(id) || this.states[id]?.status === 'updating') throw new Error('Agent update in progress')
    this.manualInstalls.add(id)
    this.idle.delete(id)
    try {
      // Drain an older check before mutation so it cannot overwrite the readback.
      await this.checks.get(id)?.catch(() => undefined)
      const state = this.states[id] ||= blank()
      state.status = 'updating'; state.error = undefined
      const result = await install()
      state.currentVersion = result.tool.version
      state.status = 'unknown'; state.checkedAt = ''
      if (result.success) {
        try { await this.checkNow(id, true) } catch { /* checkNow records failed/unknown freshness */ }
      } else { state.status = 'failed'; state.error = result.message || 'Install failed' }
      return { ...result, updateState: { ...state } }
    } catch (error) {
      const state = this.states[id] ||= blank()
      state.status = 'failed'; state.error = error instanceof Error ? error.message : 'Install failed'
      throw error
    } finally { this.manualInstalls.delete(id) }
  }

  start(): void { if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),60_000);this.timer.unref?.() }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=undefined }
  /** One check result shared by manual requests and scheduler; never install here. */
  async checkNow(id: string, afterInstall = false): Promise<Awaited<ReturnType<UpdateAdapter['check']>>> {
    if (!this.adapter.ids().includes(id)) throw new Error('Invalid agent update policy')
    if (this.manualInstalls.has(id) && !afterInstall) throw new Error('Agent install in progress')
    const pending = this.checks.get(id)
    if (pending) return pending
    const state = this.states[id] ||= blank()
    if (state.status === 'updating') throw new Error('Agent update in progress')
    state.status = 'checking'
    state.error = undefined
    const job = Promise.resolve().then(() => this.adapter.check(id)).then(result => {
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
    }).finally(() => { this.checks.delete(id) })
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
        const state=this.states[id] ||= blank()
        try {
          if (this.manualInstalls.has(id)) continue
          if(force||!state.checkedAt||Date.now()-Date.parse(state.checkedAt)>=6*60*60_000) {
            const result = await this.checkNow(id)
            if (!result.success) continue
          }
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
