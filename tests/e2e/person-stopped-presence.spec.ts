import {test,expect} from '@playwright/test'
import {resolve} from 'node:path'
import {mkdir} from 'node:fs/promises'

test('stopped Bot breathing stays off after refresh, while real new work still lights it',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  // Mock only the transport; use the production Pinia store and session row.
  await page.route('**/api/studio/session-state.ts*',route=>route.fulfill({contentType:'application/javascript',body:`
    export function connectSessionState(){
      const handlers=new Map();
      const receive=(event,payload)=>{for(const fn of handlers.get(event)||[])fn(payload)};
      const read=()=>JSON.parse(localStorage.getItem('presence-fixture')||'null')||{sessionId:'person-main-presence-fixture',profile:'default',working:true,backgroundPending:0,lastMessageId:0,readMessageId:0,unread:false};
      const socket={connected:true,on(event,fn){handlers.set(event,[...(handlers.get(event)||[]),fn]);return socket},emit(event){if(event==='sessions.state.request')receive('sessions.state.snapshot',{sessions:[read()]})},removeAllListeners(){handlers.clear()},disconnect(){socket.connected=false}};
      window.presenceTransport={update(state){localStorage.setItem('presence-fixture',JSON.stringify(state));receive('sessions.state.updated',state)}};
      queueMicrotask(()=>receive('sessions.state.snapshot',{sessions:[read()]}));return socket;
    }
  `}))
  const entry='/@fs/'+resolve('tests/e2e/fixtures/person-stopped-presence.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route('**/__stopped_presence__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`}))
  await page.goto('/__stopped_presence__')
  const row=page.locator('.session-item-agent-logo-wrap'),breathing=page.locator('.session-item-agent-logo-wrap.streaming')
  const animation=()=>row.evaluate(el=>getComputedStyle(el,'::before').animationName)
  await expect(breathing).toHaveCount(1)
  await expect.poll(animation).not.toBe('none')
  await page.getByRole('button',{name:'停止后的状态'}).click()
  await expect(row).toBeVisible();await expect(breathing).toHaveCount(0)
  await expect.poll(animation).toBe('none')
  await page.reload()
  await expect(row).toBeVisible();await expect(breathing).toHaveCount(0)
  await expect.poll(animation).toBe('none')
  if(process.env.STOPPED_PRESENCE_EVIDENCE_DIR){
    await mkdir(process.env.STOPPED_PRESENCE_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.STOPPED_PRESENCE_EVIDENCE_DIR,'stopped-after-refresh.png'),fullPage:true,animations:'disabled'})
  }
  await page.getByRole('button',{name:'真实新运行'}).click();await expect(breathing).toHaveCount(1)
  await page.getByRole('button',{name:'停止后的状态'}).click();await expect(breathing).toHaveCount(0)
  await page.getByRole('button',{name:'后台仍有任务'}).click();await expect(breathing).toHaveCount(1)
  expect(errors).toEqual([])
})
