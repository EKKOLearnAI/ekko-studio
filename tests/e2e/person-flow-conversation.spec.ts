import { expect,test,type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { PersonFlow,PersonFlowMessage } from '../../packages/client/src/api/person'

async function setup(page:Page,initialState:PersonFlow['state']='completed') {
  const errors:string[]=[],mutations:string[]=[]
  const sessions=[['creator','主发起人','zhezhe'],['api','接口 Bot','shuishui'],['ui','界面 Bot','yingying'],['other','其他 Bot','zhezhe']].map(([id,title,bot_type]) => ({
    id:`person-main-${id}`,title,bot_type,workspace:`/fixture/${id}`,profile:'default',source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',agent_mode:'scoped',history_revision:0,history_cleared_at:0,started_at:1,last_active:1,
  }))
  const flow:PersonFlow={id:'flow-a',title:'接口与界面联调',goal:'完成两端联调',creator_session_id:sessions[0].id,creator_session_title:sessions[0].title,creator_bot_type:sessions[0].bot_type,
    created_at:2000,updated_at:4000,state:initialState,revision:1,current_position:0,error:'',stages:sessions.slice(1,3).map((session,index)=>({
      id:`stage-${index}`,position:index,group_position:index,session_id:session.id,session_title:session.title,bot_type:session.bot_type,goal:'完成联调',state:initialState==='completed'?'completed':'active',result_message_id:null,tasks:[],
    })),
  }
  const entry=(id:number,index:number,content:string):PersonFlowMessage => ({id,session_id:sessions[index].id,session_title:sessions[index].title,bot_type:sessions[index].bot_type,stage_id:`stage-${index-1}`,round_number:1,role:'assistant',content,timestamp:Math.floor(Date.now()/1000)-60+id})
  const state={flow,flows:[flow],latest:[entry(30,1,'接口已完成'),entry(40,2,'界面已完成')],older:[entry(10,0,'已安排协作'),entry(20,1,'正在检查接口')],historyKey:'revision-1',fail:false,errorStatus:503,hasMore:true,snapshotDelay:0}
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{localStorage.setItem('hermes_locale','zh')})
  await page.routeWebSocket('**/socket.io/**',()=>{})
  await page.route(url=>url.pathname.startsWith('/api/'),async route=>{
    const request=route.request(),url=new URL(request.url())
    if (!['GET','HEAD'].includes(request.method())) mutations.push(request.method()+' '+url.pathname)
    let json:unknown={}
    if (url.pathname==='/api/auth/me') json={user:{id:1,username:'fixture',role:'super_admin'}}
    else if (url.pathname==='/api/auth/avatar') json={avatar:''}
    else if (url.pathname.includes('/profiles')) json={profiles:[{name:'default',active:true}]}
    else if (url.pathname==='/api/studio/person/conversations') json={sessions,next_offset:null}
    else if (url.pathname==='/api/studio/person') {
      if (state.snapshotDelay) await new Promise(resolve=>setTimeout(resolve,state.snapshotDelay))
      const session=sessions.find(session=>session.id===url.searchParams.get('session_id'))
      json={session:session||null,settings:{model:{profile:'default',provider:'fixture',model:'test-model'},agents:[],workspace:session?.workspace||'',timezone:'Asia/Shanghai',maxSteps:12,maxConcurrentTasks:6,taskTimeoutMinutes:60,compressionThreshold:null},
        revision:0,busy:false,history_revision:0,can_clear:false,inherits_global_model:true,reasoning_efforts:[],compression:{enabled:false,threshold:.8,globalThreshold:.8},contextTokens:16000,
        tasks:[],active_tasks:[],active_agent_task_count:0,schedules:[],memories:[],interactions:[],flows:state.flows,active_flows:flow.state==='active'&&session?.id===flow.creator_session_id?[flow]:[],active_flow_count:flow.state==='active'&&session?.id===flow.creator_session_id?1:0}
    } else if (url.pathname==='/api/studio/person/flows/query') json={flows:[flow]}
    else if (url.pathname==='/api/studio/person/flows/apply') {
      const input=request.postDataJSON()
      if (input.action==='stop') {flow.state='stopped';flow.revision++;flow.updated_at=5000}
      json={flow}
    } else if (url.pathname==='/api/studio/person/flows/flow-a/messages') {
      if (state.fail) return route.fulfill({status:state.errorStatus,json:{error:'fixture unavailable'}})
      const older=url.searchParams.has('before_id')
      json={flow:state.flow,messages:older?state.older:state.latest,has_more:older?false:state.hasMore,next_before_id:older?null:state.hasMore?30:null,history_key:state.historyKey}
    } else if (url.pathname==='/api/studio/workspace/directories') json={directories:[]}
    await route.fulfill({json})
  })
  const entryPath='/@fs/'+resolve('tests/e2e/fixtures/person-conversation-layout.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route('**/__flow_conversation__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entryPath}"></script></body></html>`}))
  await page.goto('/__flow_conversation__')
  await expect(page.locator('.person-title')).toHaveText('主发起人')
  await page.evaluate(()=>{
    const chat=(window as any).personWorkspaceFixture.chat
    chat.activeSession.messages=[{id:'creator-before',role:'assistant',content:'我来协调这次工作',timestamp:1000},{id:'creator-after',role:'assistant',content:'等待两端返回结果',timestamp:3000}]
    chat.activeSession.messagesLoaded=true
  })
  return {state,errors,mutations,entry,sessions}
}

const card=(page:Page)=>page.getByRole('button',{name:'查看协作对话 · 接口与界面联调',exact:true})
const transcript=(page:Page)=>page.getByRole('log',{name:'协作对话',exact:true})
const refreshTranscript=(page:Page)=>page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))

test('shows the creator card after completion, failure or stopping, and hides it again on resume',async ({page})=>{
  const {state,errors}=await setup(page,'active')
  await expect(card(page)).toHaveCount(0)
  for (const [status,label] of [['failed','需要处理'],['stopped','已中断'],['completed','已完成'],['active',null]] as const) {
    state.flow.state=status
    if (status==='completed') state.flow.stages.forEach(stage=>{stage.state='completed'})
    await page.reload()
    await expect(page.locator('.person-title')).toHaveText('主发起人')
    await expect(card(page)).toHaveCount(label?1:0)
    if (label) await expect(card(page)).toContainText(label)
  }
  expect(errors).toEqual([])
})

test('keeps activity only in the creator and leaves an accessible chat card immediately after stopping',async ({page},testInfo)=>{
  const {errors,mutations}=await setup(page,'active')
  await expect(page.locator('.person-task-island')).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  for (const name of ['接口 Bot','界面 Bot','其他 Bot']) {
    await page.locator('.person-sidebar .session-item').filter({hasText:name}).click()
    await expect(page.locator('.person-title')).toHaveText(name)
    await expect(page.locator('.person-task-island')).toHaveCount(0)
    await expect(card(page)).toHaveCount(0)
  }
  await page.locator('.person-sidebar .session-item').filter({hasText:'主发起人'}).click()
  await expect(page.locator('.person-title')).toHaveText('主发起人')
  await page.locator('.person-task-island__toggle').click()
  await page.locator('.person-flow-graph').getByRole('button').first().click()
  await page.locator('.flow-card').getByRole('button',{name:'停止流程',exact:true}).click()
  await expect(page.locator('.flow-card').getByRole('button',{name:'继续',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  await expect(card(page)).toContainText('已中断')
  await card(page).click()
  await expect(transcript(page)).toContainText('接口已完成')
  await expect(transcript(page)).toContainText('界面已完成')
  await testInfo.attach('stopped-collaboration-chat',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(card(page)).toContainText('已中断')
  await testInfo.attach('stopped-creator-card',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  expect(mutations).toEqual(['POST /api/studio/person/flows/query','POST /api/studio/person/flows/apply'])
  expect(errors).toEqual([])
})

test('opens one merged Bot conversation from the creator card, pages older replies and keeps live updates',async ({page},testInfo)=>{
  const {state,errors,mutations,entry}=await setup(page)
  await expect(card(page)).toBeVisible()
  for (const name of ['主发起人','接口 Bot','界面 Bot']) await expect(card(page)).not.toContainText(name)
  await expect(card(page).locator('.bot-sprite')).toHaveCount(2)
  await expect(card(page).locator('button')).toHaveCount(0)
  await expect(card(page).locator('.route-line')).toHaveCount(1)
  await expect(card(page).locator('.route-line')).toHaveAttribute('data-source','0')
  await expect(card(page).locator('.route-line')).toHaveAttribute('data-target','1')
  await testInfo.attach('connected-avatar-card',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await card(page).locator('.bot-sprite').first().click()
  await expect(page.locator('.person-flow-conversation .n-drawer-header')).toHaveText('接口与界面联调')
  await expect(page.locator('.flow-conversation-summary, .flow-conversation-bots')).toHaveCount(0)
  for (const text of ['接口已完成','界面已完成']) await expect(transcript(page)).toContainText(text)
  await expect(transcript(page).locator('.message-author-name')).toHaveText(['接口 Bot','界面 Bot'])
  await expect(transcript(page).locator('.reference-bubble-btn')).toHaveCount(0)
  await transcript(page).getByRole('button',{name:'更早的消息',exact:true}).click()
  await expect(transcript(page).locator('.message-author-name')).toHaveText(['主发起人','接口 Bot','接口 Bot','界面 Bot'])
  state.latest.push(entry(50,2,'两端联调通过'))
  await expect(transcript(page)).toContainText('两端联调通过',{timeout:7000})
  await expect(transcript(page).locator('.message')).toHaveCount(5)
  await refreshTranscript(page)
  await expect(transcript(page).locator('.message')).toHaveCount(5)
  await expect(page.locator('.person-title')).toHaveText('主发起人')
  await testInfo.attach('unified-collaboration-chat',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await page.keyboard.press('Escape')
  await expect(transcript(page)).toHaveCount(0)
  await page.reload()
  await expect(card(page)).toBeVisible()
  await expect(card(page)).toContainText('已完成')
  await card(page).click()
  await expect(transcript(page)).toContainText('两端联调通过')
  expect(errors).toEqual([])
  expect(mutations).toEqual([])
})

test('retries a failed transcript and replaces removed history while keeping the creator chat intact',async ({page})=>{
  const {state,errors,entry}=await setup(page)
  state.fail=true
  await card(page).click()
  await expect(page.locator('.flow-conversation-error')).toBeVisible()
  state.fail=false
  await page.locator('.flow-conversation-error').getByRole('button',{name:'重试',exact:true}).click()
  await expect(transcript(page)).toContainText('接口已完成')
  state.latest=[];state.hasMore=false;state.historyKey='revision-2'
  await refreshTranscript(page)
  await expect(transcript(page).locator('.message')).toHaveCount(0)
  await expect(transcript(page)).toContainText('暂无协作消息')
  state.latest=[entry(50,2,'已保存的新回复')]
  await refreshTranscript(page)
  await expect(transcript(page)).toContainText('已保存的新回复')
  state.fail=true;state.errorStatus=404
  await refreshTranscript(page)
  await expect(transcript(page).locator('.message')).toHaveCount(0)
  await expect(page.locator('.flow-conversation-error')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('我来协调这次工作',{exact:true})).toBeVisible()
  await page.locator('.person-sidebar .session-item').filter({hasText:'接口 Bot'}).click()
  await expect(page.locator('.person-title')).toHaveText('接口 Bot')
  await expect(card(page)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('opens the creator card and complete unified conversation on a narrow screen',async ({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844})
  const {state,errors}=await setup(page)
  state.flow.stages=Array.from({length:8},(_,index)=>({...state.flow.stages[index%2],id:`stage-${index}`,position:index,group_position:index<3?0:index-2}))
  await page.reload()
  const graph=card(page).locator('.person-flow-graph')
  await expect(graph.locator('.bot-sprite')).toHaveCount(8)
  await expect(graph.locator('.route-line')).toHaveCount(5)
  await expect(graph.locator('.flow-step[data-group="0"]')).toHaveCount(3)
  await expect.poll(()=>graph.locator('.flow-step').evaluateAll(nodes=>nodes.some(node=>Number(node.getAttribute('data-row'))>0))).toBe(true)
  await expect.poll(()=>graph.evaluate(element=>{
    const card=element.closest('.person-flow-conversation-card')!.getBoundingClientRect()
    return [...element.querySelectorAll('.bot-sprite')].every(node=>{
      const rect=node.getBoundingClientRect()
      return rect.left>=card.left&&rect.right<=card.right&&rect.top>=card.top&&rect.bottom<=card.bottom
    })
  })).toBe(true)
  expect(await card(page).evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(false)
  await testInfo.attach('connected-avatar-card-mobile',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await card(page).focus()
  await page.keyboard.press('Enter')
  await expect(transcript(page)).toContainText('界面已完成')
  await expect.poll(()=>page.locator('.person-flow-conversation').evaluate(element=>Math.round(element.getBoundingClientRect().left))).toBe(0)
  expect(await transcript(page).evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(false)
  await testInfo.attach('unified-collaboration-mobile',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await page.keyboard.press('Escape')
  await expect(card(page)).toBeVisible()
  expect(errors).toEqual([])
})

test('keeps the latest reply visible when collaboration cards load after cached messages',async ({page},testInfo)=>{
  const {state,errors,sessions}=await setup(page)
  state.flow.updated_at=3150
  state.flow.stages=Array.from({length:40},(_,index)=>({...state.flow.stages[index%2],id:`stage-${index}`,position:index,group_position:index}))
  await page.evaluate(sessions=>{
    const chat=(window as any).personWorkspaceFixture.chat
    for (const metadata of sessions) {
      const session=chat.ensureSessionLoaded(metadata)
      session.messages=Array.from({length:session.id==='person-main-creator'?160:24},(_,index)=>({id:session.id+'-'+index,role:index%2?'assistant':'user',content:`消息 ${index}\n\n`+'长对话中的历史内容。'.repeat(index%4*20+5),timestamp:index*20+1}))
      if(session.id==='person-main-creator') session.messages[159].content='收到，111。'
      session.messagesLoaded=true
      session.loadedMessageCount=session.messages.length
    }
  },sessions)
  const viewport=page.locator('.person-chat-messages .virtual-message-list')
  const bottomDistance=()=>viewport.evaluate(el=>Math.round(el.scrollHeight-el.scrollTop-el.clientHeight))
  const finalReply=page.locator('.person-chat-messages .message[id]').last()
  const finalReplyIsVisible=()=>finalReply.evaluate(el=>{
    const view=el.closest('.virtual-message-list')!.getBoundingClientRect(),reply=el.getBoundingClientRect()
    return reply.top>=view.top && reply.bottom<=view.bottom
  })
  await expect(viewport).not.toHaveClass(/vue-recycle-scroller/)
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
  for (let round=0;round<3;round++) {
    const peerSnapshot=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/studio/person' && new URL(response.url()).searchParams.get('session_id')==='person-main-api')
    await page.locator('.person-sidebar .session-item').filter({hasText:'接口 Bot'}).click()
    await (await peerSnapshot).finished()
    await expect(page.locator('.person-title')).toHaveText('接口 Bot')
    await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
    state.snapshotDelay=1800
    await page.locator('.person-sidebar .session-item').filter({hasText:'主发起人'}).click()
    // Cached messages render before the independent collaboration snapshot.
    await expect(finalReply).toContainText('收到，111。')
    await expect(page.locator('.person-flow-conversation-card')).toHaveCount(0)
    await expect.poll(finalReplyIsVisible).toBe(true)
    await expect(page.locator('.person-title')).toHaveText('主发起人')
    await expect(card(page).locator('.bot-sprite')).toHaveCount(40)
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
    // Check again after late card insertion and graph measurement settle.
    await page.waitForTimeout(1400)
    expect(await bottomDistance()).toBeLessThanOrEqual(2)
    expect(await finalReplyIsVisible()).toBe(true)
  }
  await page.setViewportSize({width:390,height:844})
  await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
  await page.waitForTimeout(1400)
  expect(await bottomDistance()).toBeLessThanOrEqual(2)
  expect(await finalReplyIsVisible()).toBe(true)
  await testInfo.attach('switched-bot-at-latest-card',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  expect(errors).toEqual([])
})

test('keeps the final reply visible while multiple cards settle and preserves deliberate history reading',async ({page},testInfo)=>{
  await page.addInitScript(()=>{
    const Observer=window.ResizeObserver
    // Mobile layout corrections can precede the transcript's resize callback.
    window.ResizeObserver=class extends Observer {
      constructor(callback:ResizeObserverCallback) {
        super((entries,observer)=>{
          if((window as any).delayFlowMeasurement && entries.some(entry=>entry.target.classList.contains('person-flow-graph'))) {
            setTimeout(()=>{
              callback(entries,observer)
              if((window as any).restoreReplyDuringMeasurement) {
                (window as any).restoreReplyDuringMeasurement=false
                requestAnimationFrame(()=>{
                  const chat=(window as any).personWorkspaceFixture.chat
                  chat.activeSession.messages.push({id:'restored-final-reply',role:'assistant',content:'收到，111。',timestamp:2000})
                })
              }
            },450)
          } else if(entries.some(entry=>entry.target.classList.contains('virtual-message-list-content'))) {
            setTimeout(()=>callback(entries,observer),80)
          } else callback(entries,observer)
        })
      }
    }
  })
  const {state,errors,sessions}=await setup(page)
  state.flow.updated_at=1950
  state.flows=[...([500,800].map((at,index)=>({...state.flow,id:`earlier-flow-${index}`,title:`早先协作 ${index}`,updated_at:at}))),state.flow]
  await page.evaluate(sessions=>{
    const chat=(window as any).personWorkspaceFixture.chat
    for(const metadata of sessions) {
      const session=chat.ensureSessionLoaded(metadata)
      session.messages=Array.from({length:100},(_,index)=>({id:session.id+'-'+index,role:index===99?'user':index%2?'assistant':'user',content:index===99?'111':`历史正文 ${index}\n\n`+'已有消息。'.repeat(12),timestamp:index*20+1}))
      session.messagesLoaded=true
      session.loadedMessageCount=100
    }
  },sessions)
  const viewport=page.locator('.person-chat-messages .virtual-message-list')
  const lastMessage=page.locator('.person-chat-messages .message[id]').last()
  const tailIsVisible=()=>lastMessage.evaluate(el=>{
    const root=el.closest('.virtual-message-list')
    if(!root || !el.isConnected)return false
    const view=root.getBoundingClientRect(),message=el.getBoundingClientRect()
    const inputTop=document.querySelector('.person-compose')!.getBoundingClientRect().top
    return message.top>=view.top && message.bottom<=Math.min(view.bottom,inputTop)
  })
  await expect(viewport).not.toHaveClass(/vue-recycle-scroller/)
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(2)
  await page.locator('.person-sidebar .session-item').filter({hasText:'接口 Bot'}).click()
  await expect(page.locator('.person-title')).toHaveText('接口 Bot')
  await page.waitForTimeout(500)
  await page.evaluate(()=>{(window as any).delayFlowMeasurement=true;(window as any).restoreReplyDuringMeasurement=true})
  await page.locator('.person-sidebar .session-item').filter({hasText:'主发起人'}).click()
  await expect(page.locator('.person-title')).toHaveText('主发起人')
  await expect(card(page)).toBeVisible()
  await page.waitForTimeout(900)
  await expect(lastMessage).toContainText('收到，111。')
  await expect.poll(tailIsVisible).toBe(true)
  await page.waitForTimeout(500)
  expect(await tailIsVisible()).toBe(true)
  await testInfo.attach('final-reply-after-card-measurement',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await viewport.hover()
  await page.mouse.wheel(0,-20)
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeGreaterThan(10)
  await page.waitForTimeout(150)
  const readingTop=await viewport.evaluate(el=>el.scrollTop)
  const size=page.viewportSize()!
  await page.setViewportSize({...size,height:size.height+10})
  await page.waitForTimeout(250)
  expect(Math.abs(await viewport.evaluate(el=>el.scrollTop)-readingTop)).toBeLessThanOrEqual(1)
  await page.evaluate(()=>{
    const chat=(window as any).personWorkspaceFixture.chat
    chat.activeSession.messages.push({id:'later-reply',role:'assistant',content:'阅读历史时的新回复不能拉动阅读位置。',timestamp:2100})
  })
  await page.waitForTimeout(500)
  expect(Math.abs(await viewport.evaluate(el=>el.scrollTop)-readingTop)).toBeLessThanOrEqual(1)

  const cdp=await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
  const pan=async (distance:number)=>{
    const box=(await viewport.boundingBox())!
    const x=box.x+box.width/2,y=box.y+box.height/2
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
    for(let step=1;step<=5;step++) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+distance*step/5}]})
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(200)
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await page.waitForTimeout(300)
  }
  await pan(-180)
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(2)
  await pan(80)
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeGreaterThan(30)
  const touchReadingTop=await viewport.evaluate(el=>el.scrollTop)
  await page.evaluate(()=>{
    const chat=(window as any).personWorkspaceFixture.chat
    chat.activeSession.messages.push({id:'touch-later-reply',role:'assistant',content:'触控上滑阅读历史后也应保留位置。',timestamp:2200})
  })
  await page.waitForTimeout(400)
  expect(Math.abs(await viewport.evaluate(el=>el.scrollTop)-touchReadingTop)).toBeLessThanOrEqual(1)
  await pan(-240)
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(2)
  await lastMessage.getByRole('button',{name:'复制消息',exact:true}).focus()
  await page.keyboard.press('PageUp')
  await expect.poll(()=>viewport.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeGreaterThan(200)
  await page.waitForTimeout(250)
  const keyboardReadingTop=await viewport.evaluate(el=>el.scrollTop)
  await page.evaluate(()=>{
    const chat=(window as any).personWorkspaceFixture.chat
    chat.activeSession.messages.push({id:'keyboard-later-reply',role:'assistant',content:'键盘阅读历史后也应保留位置。',timestamp:2300})
  })
  await page.waitForTimeout(400)
  expect(Math.abs(await viewport.evaluate(el=>el.scrollTop)-keyboardReadingTop)).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})
