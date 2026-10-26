import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { setPath: vi.fn() } }))
import { configureEarlyDesktopStorage } from '../../packages/desktop/src/main/desktop-storage-bootstrap'
it('sets custom Session sandbox root before remote startup while preserving normal local storage', () => {
 const root=mkdtempSync(join(tmpdir(),'early-storage-'))
 try {
  const host={setPath:vi.fn()}
  configureEarlyDesktopStorage(host,{},root)
  expect(host.setPath).not.toHaveBeenCalled()
  writeFileSync(join(root,'desktop-remote-server.json'),JSON.stringify({serverUrl:'https://nas.test'}))
  configureEarlyDesktopStorage(host,{HERMES_WEB_UI_HOME:root},root)
  expect(host.setPath).toHaveBeenCalledWith('sessionData',root)
  host.setPath.mockClear()
  configureEarlyDesktopStorage(host,{EKKO_STUDIO_DEVICE_INSTANCE:'test',EKKO_STUDIO_INSTANCE_USER_DATA:join(root,'electron'),HERMES_WEB_UI_HOME:root},root)
  expect(host.setPath.mock.calls.map(c=>c[0])).toEqual(['userData','sessionData'])
 } finally {rmSync(root,{recursive:true,force:true})}
})
