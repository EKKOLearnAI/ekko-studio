import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { InstallationCoordinator } from '../../packages/desktop/src/main/installation-coordinator'

it('blocks update before shutdown with another process and blocks starts during install', async () => {
 const root=mkdtempSync(join(tmpdir(),'install-coord-'))
 const handles:InstallationCoordinator[]=[]
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])
 try {
  const coordinator=new InstallationCoordinator(process.execPath,root);handles.push(coordinator)
  coordinator.register('1.0.0')
  const registry=join(root,readdirSync(root)[0])
  const db=new DatabaseSync(join(registry,'coordination.sqlite')); db.prepare('INSERT INTO members VALUES(?)').run(child.pid!);db.close()
  expect(()=>coordinator.beginInstall('2.0.0')).toThrow('DESKTOP_OTHER_DEVICE_WINDOWS_OPEN')
  child.kill();await once(child,'close')
  const cancel=coordinator.beginInstall('2.0.0')
  const concurrent=new InstallationCoordinator(process.execPath,root);handles.push(concurrent)
  expect(()=>concurrent.register('1.0.0')).toThrow('DESKTOP_INSTALLATION_IN_PROGRESS')
  expect(()=>concurrent.recoverInterruptedInstall()).toThrow('DESKTOP_INSTALLATION_IN_PROGRESS')
  cancel()
  expect(()=>concurrent.register('1.0.0')).not.toThrow()
  coordinator.release();handles.splice(handles.indexOf(coordinator),1)
 }finally {child.kill();handles.forEach(c=>c.close());rmSync(root,{recursive:true,force:true})}
})
it('does not accept a new version marker until installer process has exited',()=>{
 const root=mkdtempSync(join(tmpdir(),'install-version-'))
 try {
  const c=new InstallationCoordinator(process.execPath,root);c.register('1.0.0')
  const cancel=c.beginInstall('2.0.0')
  expect(()=>c.register('2.0.0')).toThrow('DESKTOP_INSTALLATION_IN_PROGRESS')
  cancel();c.release()
 }finally {rmSync(root,{recursive:true,force:true})}
})
it('accepts a completed new-version handoff but refuses a dead old-version start',()=>{
 const root=mkdtempSync(join(tmpdir(),'install-handoff-'))
 try {
  const c=new InstallationCoordinator(process.execPath,root)
  const registry=join(root,readdirSync(root)[0])
  // A large PID absent in the test host models the completed installer owner.
  const dead=2147483647
  const db=new DatabaseSync(join(registry,'coordination.sqlite'));db.prepare('INSERT INTO installation VALUES(1,?,?)').run(dead,'2.0.0');db.close()
  expect(()=>c.register('1.0.0')).toThrow('DESKTOP_INSTALLATION_IN_PROGRESS')
  expect(()=>c.register('2.0.0')).not.toThrow()
  c.release()
 }finally {rmSync(root,{recursive:true,force:true})}
})
it('requires explicit recovery for dead old-version install markers',()=>{
 const root=mkdtempSync(join(tmpdir(),'install-explicit-recovery-'))
 try{
  const c=new InstallationCoordinator(process.execPath,root)
  const registry=join(root,readdirSync(root)[0])
  const db=new DatabaseSync(join(registry,'coordination.sqlite'))
  db.prepare('INSERT INTO installation VALUES(1,?,?)').run(2147483647,'2.0.0');db.close()
  expect(()=>c.register('1.0.0')).toThrow('DESKTOP_INSTALLATION_IN_PROGRESS')
  c.recoverInterruptedInstall();c.register('1.0.0');c.release()
 }finally{rmSync(root,{recursive:true,force:true})}
})
