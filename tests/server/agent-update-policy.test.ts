import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentUpdatePolicy } from '../../packages/server/src/modules/coding-agents/services/update-policy'
const dirs:string[]=[]
afterEach(async()=>{for(const p of dirs.splice(0))await rm(p,{recursive:true,force:true})})
async function setup(){const dir=await mkdtemp(join(tmpdir(),'update-policy-'));dirs.push(dir);const adapter={ids:()=>['codex'],check:vi.fn(async()=>({success:true,tool:{installed:true,version:'1'},latestVersion:'2',updateAvailable:true})),install:vi.fn(async()=>({success:true,tool:{version:'2'}})),busy:vi.fn(()=>false),safelyManaged:vi.fn(()=>true),activityRevision:vi.fn(()=>0)};return {dir,adapter,policy:new AgentUpdatePolicy(dir,adapter)}}
it('checks by default without installing and never treats errors as latest',async()=>{
 const {policy,adapter}=await setup();await policy.load();await policy.tick();expect(policy.snapshot().codex.status).toBe('available');expect(adapter.install).not.toHaveBeenCalled()
 adapter.check.mockRejectedValueOnce(new Error('offline'));await policy.tick(true);expect(policy.snapshot().codex.status).toBe('failed');expect(policy.snapshot().codex.latestVersion).toBe('2')
})
it('persists one opt-in switch, waits while busy, stops installing after revocation',async()=>{
 const {policy,adapter,dir}=await setup();await policy.set('codex',true);adapter.busy.mockReturnValue(true);await policy.tick();expect(policy.snapshot().codex.status).toBe('waiting');expect(adapter.install).not.toHaveBeenCalled()
 await policy.set('codex',false);adapter.busy.mockReturnValue(false);await policy.tick();expect(adapter.install).not.toHaveBeenCalled()
 const next=new AgentUpdatePolicy(dir,adapter);await next.load();expect(next.snapshot().codex.autoUpdate).toBe(false)
 vi.useFakeTimers();try { await policy.set('codex',true);await policy.tick();expect(adapter.install).not.toHaveBeenCalled();vi.advanceTimersByTime(60000);await policy.tick();expect(adapter.install).toHaveBeenCalledTimes(1) } finally {vi.useRealTimers()}
})
it('validates policy and prevents concurrent scheduler execution',async()=>{const {policy,adapter}=await setup();await expect(policy.set('other',true)).rejects.toThrow();await expect(policy.set('codex','true')).rejects.toThrow();await Promise.all([policy.tick(),policy.tick()]);expect(adapter.check).toHaveBeenCalledTimes(1)})

it('manual success clears a background failure in shared state and does not install', async () => {
  const { policy, adapter } = await setup()
  adapter.check.mockRejectedValueOnce(new Error('temporary failure'))
  await policy.tick()
  expect(policy.snapshot().codex.status).toBe('failed')
  await policy.checkNow('codex')
  expect(policy.snapshot().codex).toMatchObject({status:'available',latestVersion:'2',error:undefined})
  expect(adapter.install).not.toHaveBeenCalled()
  await policy.tick()
  expect(policy.snapshot().codex.error).toBeUndefined()
})
it('concurrent manual/background checks share one result rather than overwrite with stale failure', async () => {
  const { policy, adapter } = await setup()
  let resolveCheck!: (value: Awaited<ReturnType<typeof adapter.check>>) => void
  adapter.check.mockImplementationOnce(() => new Promise(resolve => { resolveCheck=resolve }))
  const tick = policy.tick()
  const manual = policy.checkNow('codex')
  await Promise.resolve()
  expect(adapter.check).toHaveBeenCalledTimes(1)
  resolveCheck({success:true,tool:{installed:true,version:'1'},latestVersion:'2',updateAvailable:true})
  await Promise.all([tick,manual])
  expect(policy.snapshot().codex.status).toBe('available')
})

it('unsupported external installations cannot enable automatic updates',async()=>{
 const {policy,adapter}=await setup();adapter.safelyManaged.mockReturnValue(false)
 await expect(policy.set('codex',true)).rejects.toThrow('not supported')
 await policy.tick();expect(policy.snapshot().codex.autoUpdateSupported).toBe(false);expect(adapter.install).not.toHaveBeenCalled()
})
it('skips unsupported agents in normal and forced background checks without blocking supported agents', async () => {
  const { dir, adapter } = await setup()
  const check = vi.fn(async (id: string) => ({
    success: id !== 'cursor',
    tool: { installed: true, version: '1' },
    latestVersion: id === 'cursor' ? '' : '2',
    updateAvailable: id !== 'cursor',
    message: id === 'cursor' ? 'Cursor CLI updates are not managed by Studio' : '',
  }))
  const policy = new AgentUpdatePolicy(dir, {
    ...adapter,
    ids: () => ['cursor', 'codex'],
    safelyManaged: id => id !== 'cursor',
    check,
  })

  await policy.tick()
  await policy.tick(true)

  expect(check.mock.calls).toEqual([['codex'], ['codex']])
  expect(policy.snapshot().cursor).toMatchObject({
    autoUpdate: false,
    autoUpdateSupported: false,
    status: 'unknown',
    checkedAt: '',
  })
  expect(policy.snapshot().cursor.error).toBeUndefined()
  expect(policy.snapshot().codex.status).toBe('available')
  expect(adapter.install).not.toHaveBeenCalled()
})
it('requires 60 continuous safe seconds and resets on short activity between polls',async()=>{
 vi.useFakeTimers()
 try {
  const {policy,adapter}=await setup();await policy.set('codex',true);await policy.tick()
  vi.advanceTimersByTime(59000);await policy.tick();expect(adapter.install).not.toHaveBeenCalled()
  adapter.activityRevision.mockReturnValue(1);vi.advanceTimersByTime(1000);await policy.tick();expect(adapter.install).not.toHaveBeenCalled()
  vi.advanceTimersByTime(60000);await policy.tick();expect(adapter.install).toHaveBeenCalledTimes(1)
 }finally{vi.useRealTimers()}
})
it('disabling automatic update while a version check is pending prevents installation',async()=>{
 const {policy,adapter}=await setup();await policy.set('codex',true)
 let done!:(r:Awaited<ReturnType<typeof adapter.check>>)=>void
 adapter.check.mockImplementationOnce(()=>new Promise(resolve=>{done=resolve}))
 const tick=policy.tick();await Promise.resolve();await policy.set('codex',false)
 done({success:true,tool:{installed:true,version:'1'},latestVersion:'2',updateAvailable:true})
 await tick;expect(adapter.install).not.toHaveBeenCalled();expect(policy.snapshot().codex.autoUpdate).toBe(false)
})
it('manual install refreshes shared state and preserves a still-available update',async()=>{
 const {policy,adapter}=await setup();await policy.checkNow('codex')
 adapter.check.mockResolvedValueOnce({success:true,tool:{installed:true,version:'2'},latestVersion:'2',updateAvailable:false})
 const result=await policy.installAndRefresh('codex',async()=>({success:true,tool:{version:'2'}}))
 expect(result.updateState).toMatchObject({status:'current',currentVersion:'2',error:undefined})
 expect(policy.snapshot().codex.status).toBe('current')
 adapter.check.mockResolvedValueOnce({success:true,tool:{installed:true,version:'2'},latestVersion:'3',updateAvailable:true})
 const older=await policy.installAndRefresh('codex',async()=>({success:true,tool:{version:'2'}}))
 expect(older.updateState.status).toBe('available')
 expect(adapter.install).not.toHaveBeenCalled()
})
it('install success with failed version check does not claim latest',async()=>{
 const {policy,adapter}=await setup();adapter.check.mockRejectedValueOnce(new Error('offline'))
 const result=await policy.installAndRefresh('codex',async()=>({success:true,tool:{version:'2'}}))
 expect(result.success).toBe(true);expect(result.updateState).toMatchObject({status:'failed',currentVersion:'2',error:'offline'})
})
