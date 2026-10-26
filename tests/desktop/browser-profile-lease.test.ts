import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron',()=>({app:{getLocale:()=> 'en'}}))
import { BrowserProfileLeases } from '../../packages/desktop/src/main/browser/browser-profile-lease'
it('reuses a process lease across manager instances and symlink aliases',async()=>{
 const root=mkdtempSync(join(tmpdir(),'profile-lease-'));const releases:Array<()=>void>=[]
 try {
  const a=new BrowserProfileLeases(release=>releases.push(release))
  const b=new BrowserProfileLeases(release=>releases.push(release))
  await Promise.all([a.acquire(join(root,'data')),a.acquire(join(root,'data'))])
  expect(existsSync(join(root,'data'))).toBe(false)
  mkdirSync(join(root,'data'))
  symlinkSync(join(root,'data'),join(root,'alias'),process.platform==='win32'?'junction':'dir')
  await expect(b.acquire(join(root,'alias'))).resolves.toBeUndefined()
  expect(releases.length).toBe(1)
 }finally {releases.forEach(release=>release());rmSync(root,{recursive:true,force:true})}
})
