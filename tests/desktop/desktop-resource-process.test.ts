import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

it('protects profiles and install handoff between real processes', async () => {
 const root=mkdtempSync(join(tmpdir(),'desktop-resources-'))
 const dist=join(root,'dist');mkdirSync(join(dist,'browser'),{recursive:true})
 for(const file of ['installation-coordinator','browser/browser-profile-lease','device-window-owner']){
  buildSync({entryPoints:[resolve(`packages/desktop/src/main/${file}.ts`)],outfile:join(dist,`${file}.js`),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'})
 }
 const children:ChildProcessWithoutNullStreams[]=[]
 const launch=(extra:Record<string,string>)=>{
  const child=spawn(process.execPath,[resolve('tests/fixtures/desktop-resource-owner.cjs')],{env:{...process.env,PROBE_DIST:dist,...extra}})
  children.push(child)
  const lines:string[]=[];const waiters:Array<(value:any)=>void>=[]
  createInterface({input:child.stdout}).on('line',line=>{const next=waiters.shift();if(next)next(JSON.parse(line));else lines.push(line)})
  const receive=()=>lines.length?Promise.resolve(JSON.parse(lines.shift()!)):new Promise<any>((res,rej)=>{
   const timer=setTimeout(()=>rej(new Error('Resource process response timed out')),5000)
   waiters.push(value=>{clearTimeout(timer);res(value)})
  })
  return {child,receive,send:(value:string)=>child.stdin.write(value+'\n')}
 }
 const exit=async(worker:ReturnType<typeof launch>)=>{
  const done=new Promise<void>(res=>worker.child.once('close',()=>res()))
  worker.send('quit');await done
 }
 try{
  const profile=join(root,'profile'),alias=join(root,'alias')
  mkdirSync(profile)
  const a=launch({PROBE_PROFILE:profile});expect((await a.receive()).event).toBe('profile-owned')
  symlinkSync(profile,alias,process.platform==='win32'?'junction':'dir')
  const b=launch({PROBE_PROFILE:alias});expect((await b.receive()).event).toBe('blocked')
  await exit(a)
  const c=launch({PROBE_PROFILE:profile});expect((await c.receive()).event).toBe('profile-owned');await exit(c)
  const { deviceWindowEndpoint } = await import('../../packages/desktop/src/main/device-window-owner')
  const endpoint=deviceWindowEndpoint(root,'https://stress.test')
  const owner=launch({PROBE_DEVICE:endpoint});expect((await owner.receive()).event).toBe('device-owned')
  const duplicates=Array.from({length:6},()=>launch({PROBE_DEVICE:endpoint}))
  for(const duplicate of duplicates)expect((await duplicate.receive()).event).toBe('reused')
  // Crash, then simultaneous reopen: exactly one owner, others reuse it.
  const died=new Promise<void>(resolve=>owner.child.once('close',()=>resolve()))
  owner.child.kill('SIGKILL');await died
  const reopened=Array.from({length:4},()=>launch({PROBE_DEVICE:endpoint}))
  const outcomes=await Promise.all(reopened.map(worker=>worker.receive()))
  expect(outcomes.filter(result=>result.event==='device-owned')).toHaveLength(1)
  expect(outcomes.filter(result=>result.event==='reused')).toHaveLength(3)
  await exit(reopened[outcomes.findIndex(result=>result.event==='device-owned')])
  const registry=join(root,'registry')
  const first=launch({PROBE_REGISTRY:registry}),second=launch({PROBE_REGISTRY:registry})
  expect((await first.receive()).event).toBe('registered');expect((await second.receive()).event).toBe('registered')
  first.send('install');expect((await first.receive()).event).toBe('blocked')
  await exit(second)
  first.send('install');expect((await first.receive()).event).toBe('install-held')
  const blocked=launch({PROBE_REGISTRY:registry});expect((await blocked.receive()).event).toBe('blocked')
  await exit(first)
  const retry=launch({PROBE_REGISTRY:registry});expect((await retry.receive()).event).toBe('registered');await exit(retry)
  const crashed=launch({PROBE_REGISTRY:registry});expect((await crashed.receive()).event).toBe('registered')
  crashed.send('transaction');expect((await crashed.receive()).event).toBe('transaction-open')
  const crashedExit=new Promise<void>(resolve=>crashed.child.once('close',()=>resolve()))
  crashed.child.kill('SIGKILL');await crashedExit
  const recovered=launch({PROBE_REGISTRY:registry});expect((await recovered.receive()).event).toBe('registered')
  recovered.send('install');expect((await recovered.receive()).event).toBe('install-held');await exit(recovered)

 }finally{
  await Promise.all(children.map(child=>new Promise<void>(res=>{if(child.exitCode!==null||child.signalCode!==null)return res();child.once('close',()=>res());child.kill()})))
  rmSync(root,{recursive:true,force:true})
 }
},20000)
