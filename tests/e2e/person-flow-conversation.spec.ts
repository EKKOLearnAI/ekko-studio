import { expect,test,type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { PersonFlow,PersonFlowMessage } from '../../packages/client/src/api/person'
import { mockPersonResume,type PersonResumeFixture } from './fixtures/person-resume'

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
  const state={flow,flows:[flow],timelinePages:new Map<string,PersonResumeFixture>(),timelineReads:[] as string[],latest:[entry(30,1,'接口已完成'),entry(40,2,'界面已完成')],older:[entry(10,0,'已安排协作'),entry(20,1,'正在检查接口')],historyKey:'revision-1',fail:false,errorStatus:503,hasMore:true,snapshotDelay:0,resumeDelay:0,
    messages:{[sessions[0].id]:[{id:'creator-before',role:'assistant',content:'我来协调这次工作',timestamp:1000},{id:'creator-after',role:'assistant',content:'等待两端返回结果',timestamp:3000}]} as Record<string,PersonResumeFixture['messages']>,historyClearedAt:0}
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{localStorage.setItem('hermes_locale','zh')})
  const resume=await mockPersonResume(page,id=>state.timelinePages.get(id===flow.creator_session_id?'':'peer') || ({messages:state.messages[id] || [],personFlows:{flows:state.flows,
    active_flows:state.flow.state==='active'&&id===flow.creator_session_id?[flow]:[],active_flow_count:state.flow.state==='active'&&id===flow.creator_session_id?1:0,history_cleared_at:state.historyClearedAt}}),()=>state.resumeDelay)
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
        tasks:[],active_tasks:[],active_agent_task_count:0,schedules:[],memories:[],interactions:[],
        ...(url.searchParams.get('include_flows')==='false'?{}:{flows:state.flows,active_flows:flow.state==='active'&&session?.id===flow.creator_session_id?[flow]:[],active_flow_count:flow.state==='active'&&session?.id===flow.creator_session_id?1:0})}
    } else if (url.pathname==='/api/studio/person/flows/query') json={flows:[flow]}
    else if (url.pathname==='/api/studio/person/flows/apply') {
      const input=request.postDataJSON()
      if (input.action==='stop') {flow.state='stopped';flow.revision++;flow.updated_at=5000}
      resume.publish(flow.creator_session_id!)
      json={flow}
    } else if (url.pathname==='/api/studio/person/flows/flow-a/messages') {
      if (state.fail) return route.fulfill({status:state.errorStatus,json:{error:'fixture unavailable'}})
      const older=url.searchParams.has('before_id')
      json={flow:state.flow,messages:older?state.older:state.latest,has_more:older?false:state.hasMore,next_before_id:older?null:state.hasMore?30:null,history_key:state.historyKey}
    } else if (url.pathname.includes('/messages/paginated')) {
      const id=decodeURIComponent(url.pathname.split('/')[5]),messages=state.messages[id] || []
      if(id===flow.creator_session_id && state.timelinePages.size && url.searchParams.get('timeline')==='true') {
        const before=url.searchParams.get('before') || ''
        state.timelineReads.push(before)
        const value=state.timelinePages.get(before)!
        return route.fulfill({json:{session:sessions[0],messages:value.messages.map(message=>({...message,timestamp:message.timestamp/1000})),
          personFlows:value.personFlows,total:253,offset:0,limit:150,hasMore:value.personFlows.timeline!.has_more}})
      }
      json={session:sessions.find(session=>session.id===id),messages:messages.map(message=>({...message,timestamp:message.timestamp/1000})),personFlows:{flows:state.flows,active_flows:[],active_flow_count:0,history_cleared_at:state.historyClearedAt},total:messages.length,hasMore:false}
    } else if (url.pathname==='/api/studio/workspace/directories') json={directories:[]}
    await route.fulfill({json})
  })
  const entryPath='/@fs/'+resolve('tests/e2e/fixtures/person-conversation-layout.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route(url=>url.pathname==='/__flow_conversation__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entryPath}"></script></body></html>`}))
  await page.goto('/__flow_conversation__?resume=1')
  await expect(page.locator('.person-title')).toHaveText('主发起人')
  await expect.poll(()=>page.evaluate(()=>(window as any).personWorkspaceFixture.chat.activeSession?.messagesLoaded)).toBe(true)
  return {state,errors,mutations,entry,sessions,resume}
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

test('pages messages and old collaboration cards together within a bounded window and keeps desktop cards left aligned',async ({page},testInfo)=>{
  await page.setViewportSize({width:2048,height:1152})
  const {state,resume,errors}=await setup(page)
  const cards=Array.from({length:380},(_,index)=>index%3===0?{...state.flow,id:`flow-${index}`,title:`协作 ${index}`,created_at:1,updated_at:(index+1)*1000,timeline_at:(index+1)*1000}:null).filter(Boolean) as PersonFlow[]
  state.flows=cards.slice(-50)
  for(const [start,end] of [[230,380],[80,230],[0,80]]) {
    const ownCards=cards.filter(flow=>flow.timeline_at!>(start*1000) && flow.timeline_at!<=(end*1000))
    const value:PersonResumeFixture={messages:[],personFlows:{flows:state.flows,active_flows:[],active_flow_count:0,history_cleared_at:0,cards:ownCards,
      timeline:{items:[],before:start?`window-${start}`:null,has_more:start>0,history_revision:0}}}
    for(let index=start;index<end;index++) {
      const timestamp=(index+1)*1000,card=index%3===0
      value.personFlows.timeline!.items.push({id:card?`flow-${index}`:String(index+1000),kind:card?'flow':'message',timestamp,cursor:`window-${index}`})
      if(!card) value.messages.push({id:String(index+1000),role:'assistant',content:`历史回复 ${index}`,timestamp})
    }
    state.timelinePages.set(end===380?'':`window-${end}`,value)
  }
  await page.reload()
  await expect(page.locator('#message-1379')).toContainText('历史回复 379')
  const viewport=page.locator('.person-chat-messages .virtual-message-list')
  const count=()=>page.evaluate(()=>(window as any).personWorkspaceFixture.chat.activeSession.personFlows.timeline.items.length)
  expect(await count()).toBe(150)
  for(let index=0;index<2;index++) {
    await viewport.hover()
    await page.mouse.wheel(0,-100000)
    await expect.poll(()=>state.timelineReads.length).toBe(index+1)
    await expect.poll(count).toBe(300)
  }
  await expect(page.getByRole('button',{name:'查看协作对话 · 协作 0',exact:true})).toHaveCount(1)
  expect(state.timelineReads).toEqual(['window-230','window-80'])
  expect(await page.evaluate(()=>(window as any).personWorkspaceFixture.chat.activeSession.personFlows.timeline.has_newer)).toBe(true)
  await page.locator('.person-sidebar .session-item').filter({hasText:'接口 Bot'}).click()
  await expect(page.locator('.person-title')).toHaveText('接口 Bot')
  await page.locator('.person-sidebar .session-item').filter({hasText:'主发起人'}).click()
  await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
  await expect.poll(count).toBe(300)
  expect(await page.evaluate(()=>(window as any).personWorkspaceFixture.chat.activeSession.personFlows.timeline.has_newer)).toBe(true)
  // A recent status snapshot must retain older cards in the loaded window.
  resume.publish('person-main-creator')
  await expect(page.getByRole('button',{name:'查看协作对话 · 协作 0',exact:true})).toHaveCount(1)
  const first=page.locator('.person-flow-conversation-card').first()
  await first.scrollIntoViewIfNeeded()
  const geometry=await first.evaluate(el=>{
    const card=el.getBoundingClientRect(),row=el.closest('.virtual-row')!.getBoundingClientRect()
    return {left:card.left-row.left,width:card.width,rowWidth:row.width}
  })
  expect(Math.abs(geometry.left)).toBeLessThanOrEqual(1)
  expect(geometry.width).toBeLessThan(geometry.rowWidth-100)
  await page.screenshot({path:testInfo.outputPath('timeline-desktop-left.png'),animations:'disabled'})
  await page.evaluate(()=>{
    const theme=(window as any).personWorkspaceFixture.theme
    theme.previewThemeSettings({brightness:'dark',appearance:{global:{opacity:.7},regions:{card:{opacity:.4,blur:4,radius:10,backgroundColor:'#627a94'}}}})
    document.documentElement.classList.add('theme-has-custom-background')
    document.documentElement.style.setProperty('--app-background-image','linear-gradient(120deg, #607080, #a0a090)')
  })
  await expect(first).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('timeline-dark-wallpaper.png'),animations:'disabled'})
  await page.evaluate(()=>{
    (window as any).personWorkspaceFixture.theme.previewThemeSettings({brightness:'light',appearance:{global:{opacity:1},regions:{}}})
    document.documentElement.classList.remove('theme-has-custom-background')
    document.documentElement.style.setProperty('--app-background-image','none')
  })
  await page.locator('.scroll-bottom-button').click()
  await expect(page.locator('#message-1379')).toBeVisible()
  await expect.poll(count).toBe(150)
  expect(state.timelineReads.at(-1)).toBe('')
  expect(await page.evaluate(()=>(window as any).personWorkspaceFixture.chat.activeSession.personFlows.timeline.has_newer)).toBe(false)
  await page.setViewportSize({width:390,height:844})
  await expect.poll(()=>viewport.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await page.screenshot({path:testInfo.outputPath('timeline-mobile.png'),animations:'disabled'})
  expect(errors).toEqual([])
})

test('can continue to older history when a timeline page contains only hidden display rows',async ({page})=>{
  const {state,errors}=await setup(page)
  state.timelinePages.set('',{messages:[{id:'hidden',role:'assistant',content:'',timestamp:5000}],personFlows:{flows:[],cards:[],active_flows:[],active_flow_count:0,history_cleared_at:0,
    timeline:{items:[{id:'hidden',kind:'message',timestamp:5000,cursor:'hidden-page'}],before:'hidden-page',has_more:true,history_revision:0}}})
  state.timelinePages.set('hidden-page',{messages:[{id:'older-visible',role:'assistant',content:'更早的公开回复',timestamp:4000}],personFlows:{flows:[],cards:[],active_flows:[],active_flow_count:0,history_cleared_at:0,
    timeline:{items:[{id:'older-visible',kind:'message',timestamp:4000,cursor:'end'}],before:null,has_more:false,history_revision:0}}})
  await page.reload()
  const more=page.locator('.history-loader button')
  await expect(more).toBeVisible()
  await more.click()
  await expect(page.locator('#message-older-visible')).toContainText('更早的公开回复')
  expect(state.timelineReads).toEqual(['hidden-page'])
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

test('restores cards with messages before the independent Bot settings snapshot',async ({page},testInfo)=>{
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
  state.messages=await page.evaluate(()=>Object.fromEntries((window as any).personWorkspaceFixture.chat.sessions.map((session:any)=>[session.id,session.messages])))
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
    // Cached messages and cards return together, before the unrelated settings read.
    await expect(finalReply).toContainText('收到，111。')
    await expect(page.locator('.person-flow-conversation-card')).toHaveCount(1)
    await expect(page.locator('.person-view')).toHaveAttribute('inert')
    await expect.poll(finalReplyIsVisible).toBe(true)
    await expect(page.locator('.person-title')).toHaveText('主发起人')
    await expect(card(page).locator('.bot-sprite')).toHaveCount(40)
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2)
    // Check again after graph measurement and the unrelated settings read settle.
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

test('renders a cold resumed transcript and collaboration together and applies pushed flow changes',async ({page})=>{
  const {state,resume,errors,mutations}=await setup(page)
  const reads:string[]=[]
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/studio/person')reads.push(url.search)})
  state.flow.updated_at=4500
  state.messages['person-main-creator']=[{id:'user-111',role:'user',content:'111',timestamp:4400},{id:'reply-111',role:'assistant',content:'收到，111。',timestamp:5000}]
  await page.locator('.person-sidebar .session-item').filter({hasText:'接口 Bot'}).click()
  await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
  await page.evaluate(()=>{
    const fixture=(window as any).personWorkspaceFixture
    const creator=fixture.chat.sessions.find((session:any)=>session.id==='person-main-creator')
    creator.messages=[];creator.messagesLoaded=false;creator.personFlows=undefined
    fixture.resumePhases=[]
    fixture.resumeObserver=new MutationObserver(()=>{
      if(fixture.chat.activeSessionId!=='person-main-creator')return
      fixture.resumePhases.push({reply:!!document.getElementById('message-reply-111'),card:!!document.querySelector('.person-flow-conversation-card')})
    })
    fixture.resumeObserver.observe(document.querySelector('.person-chat-messages'),{childList:true,subtree:true})
  })
  state.snapshotDelay=2500;state.resumeDelay=300
  await page.locator('.person-sidebar .session-item').filter({hasText:'主发起人'}).click()
  await expect(page.locator('#message-reply-111')).toContainText('收到，111。')
  await expect(page.locator('.person-flow-conversation-card')).toHaveCount(1)
  await expect(page.locator('.person-view')).toHaveAttribute('inert')
  const phases=await page.evaluate(()=>{const fixture=(window as any).personWorkspaceFixture;fixture.resumeObserver.disconnect();return fixture.resumePhases as Array<{reply:boolean;card:boolean}>})
  expect(phases.some(phase=>phase.reply&&phase.card)).toBe(true)
  expect(phases.some(phase=>phase.reply!==phase.card)).toBe(false)
  await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
  state.snapshotDelay=2500
  state.flow.state='active';state.flow.revision++
  state.flow.stages.forEach((stage,index)=>{stage.state=index?'pending':'active'})
  resume.publish('person-main-creator')
  await expect(page.locator('.person-flow-conversation-card')).toHaveCount(0)
  await expect(page.locator('.person-task-island')).toBeVisible()
  state.flow.state='stopped';state.flow.revision++
  resume.publish('person-main-creator')
  await expect(page.locator('.person-flow-conversation-card')).toHaveCount(1)
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  state.historyClearedAt=state.flow.created_at!+1
  resume.publish('person-main-creator')
  await expect(page.locator('.person-flow-conversation-card')).toHaveCount(0)
  state.historyClearedAt=0
  state.messages['person-main-creator'].push({id:'refresh-reply',role:'assistant',content:'刷新时也一并恢复协作记录。',timestamp:6000})
  expect(await page.evaluate(()=>(window as any).personWorkspaceFixture.chat.refreshActiveSession())).toBe(true)
  await expect(page.locator('#message-refresh-reply')).toContainText('刷新时也一并恢复协作记录。')
  await expect(page.locator('.person-flow-conversation-card')).toHaveCount(1)
  expect(resume.requested).toContain('person-main-creator')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every(query=>new URLSearchParams(query).get('include_flows')==='false')).toBe(true)
  expect(mutations).toEqual([])
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
  state.messages=await page.evaluate(()=>Object.fromEntries((window as any).personWorkspaceFixture.chat.sessions.map((session:any)=>[session.id,session.messages])))
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
