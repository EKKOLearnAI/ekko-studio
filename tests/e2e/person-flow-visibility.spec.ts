import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { PersonFlow } from '../../packages/client/src/api/person'
import { mockPersonResume } from './fixtures/person-resume'

async function setup(page: Page, state: 'active' | 'completed' | 'empty' = 'completed', creator = false) {
  const active = state === 'active'
  const errors: string[] = []
  const session = { id:'person-main-participant',title:'研发 Bot',bot_type:'shuishui',workspace:'/fixture/bot',profile:'default',source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',agent_mode:'scoped',history_revision:0,started_at:1,last_active:1 }
  const flow: PersonFlow = {
    id:'collaboration',title:'App 与 Studio 联调',goal:'完成接口联调并核对结果',creator_session_id:creator ? session.id : 'person-main-creator',
    state:active ? 'active' : 'completed',revision:1,current_position:0,error:'',
    stages:[['person-main-creator','规划 Bot'],[session.id,session.title]].map(([id,name],index) => ({
      id:`stage-${index}`,position:index,group_position:index,session_id:id,session_title:name,bot_type:'shuishui',
      goal:index ? '核对接口结果' : '给出接口方案',state:active ? (index ? 'pending' : 'active') : 'completed',
      result_message_id:active ? null : 100+index,tasks:[],
    })),
  }
  page.on('pageerror',error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale','zh') })
  await mockPersonResume(page,()=>({messages:[],personFlows:{flows:state==='empty'?[]:[flow],active_flows:active?[flow]:[],active_flow_count:active?1:0,history_cleared_at:0}}))
  await page.route(url => url.pathname.startsWith('/api/'),async route => {
    const url = new URL(route.request().url())
    let json: unknown = {}
    if (url.pathname === '/api/auth/me') json = {user:{id:1,username:'fixture',role:'super_admin'}}
    else if (url.pathname === '/api/auth/avatar') json = {avatar:''}
    else if (url.pathname.includes('/profiles')) json = {profiles:[{name:'default',active:true}]}
    else if (url.pathname === '/api/studio/person/conversations') json = {sessions:[session],next_offset:null}
    else if (url.pathname === '/api/studio/person') json = {
      session:url.searchParams.has('session_id') ? session : null,
      settings:{model:{profile:'default',provider:'fixture',model:'test-model'},agents:[],workspace:session.workspace,timezone:'Asia/Shanghai',maxSteps:12,maxConcurrentTasks:6,taskTimeoutMinutes:60,compressionThreshold:null},
      revision:0,busy:false,history_revision:0,can_clear:false,inherits_global_model:true,reasoning_efforts:[],compression:{enabled:false,threshold:.8,globalThreshold:.8},contextTokens:16000,
      tasks:[],active_tasks:[],active_agent_task_count:0,schedules:[],memories:[],interactions:[],
    }
    else if (url.pathname === '/api/studio/person/flows/query') json = {flows:[flow]}
    else if (url.pathname === '/api/studio/workspace/directories') json = {directories:[]}
    await route.fulfill({json})
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-conversation-layout.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route(url=>url.pathname==='/__flow_visibility__',route => route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`}))
  await page.goto('/__flow_visibility__?resume=1')
  await expect(page.locator('.person-title')).toHaveText(session.title)
  return errors
}

test('keeps collaboration history accessible from Bot chat after activity ends',async ({page},testInfo) => {
  const errors = await setup(page)
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  const shortcut = page.locator('.person-header-actions').getByRole('button',{name:'设置',exact:true})
  await shortcut.click()
  await expect(shortcut).toHaveAttribute('aria-expanded','true')
  await page.getByRole('tab',{name:'协作流程',exact:true}).click()
  await expect(page.getByRole('tab',{name:'协作流程',exact:true})).toHaveAttribute('aria-selected','true')
  await page.getByRole('button',{name:'App 与 Studio 联调',exact:true}).click()
  await expect(page.getByRole('button',{name:'查看成果',exact:true})).toHaveCount(2)
  await expect(page.locator('.flow-role-name')).toHaveText(['规划 Bot','研发 Bot'])
  await testInfo.attach('collaboration-history',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  expect(errors).toEqual([])
})

test('shows the live flow graph only in its creator and opens its details',async ({page},testInfo) => {
  const errors = await setup(page,'active',true)
  const activity = page.getByRole('button',{name:/研发 Bot.*协作流程.*1/})
  await activity.click()
  const graph = page.locator('.person-flow-graph')
  await expect(graph).toBeVisible()
  await expect(graph.getByRole('button')).toHaveCount(2)
  await expect.poll(() => graph.evaluate(element => {
    const bounds = element.getBoundingClientRect(), capsule = element.closest('.person-task-island')!.getBoundingClientRect()
    return bounds.top >= capsule.top && bounds.bottom <= capsule.bottom
  })).toBe(true)
  await testInfo.attach('creator-collaboration',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  await graph.getByRole('button').last().click()
  await expect(page.locator('[data-flow-id="collaboration"] > .flow-row')).toHaveAttribute('aria-expanded','true')
  await expect(page.locator('.flow-role-name')).toHaveText(['规划 Bot','研发 Bot'])
  expect(errors).toEqual([])
})

test('hides the collaboration capsule in a participating Bot while keeping details accessible',async ({page}) => {
  const errors = await setup(page,'active')
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  await page.locator('.person-header-actions').getByRole('button',{name:'设置',exact:true}).click()
  await page.getByRole('tab',{name:'协作流程',exact:true}).click()
  await page.getByRole('button',{name:'App 与 Studio 联调',exact:true}).click()
  await expect(page.locator('.flow-role-name')).toHaveText(['规划 Bot','研发 Bot'])
  expect(errors).toEqual([])
})

test('opens an empty collaboration panel from a narrow Bot chat',async ({page},testInfo) => {
  await page.setViewportSize({width:390,height:844})
  const errors = await setup(page,'empty')
  const shortcut = page.locator('.person-header-actions').getByRole('button',{name:'设置',exact:true})
  await expect(shortcut).toBeInViewport()
  expect(await page.locator('.person-header').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await shortcut.click()
  await page.getByRole('tab',{name:'协作流程',exact:true}).click()
  await expect(page.getByRole('tab',{name:'协作流程',exact:true})).toHaveAttribute('aria-selected','true')
  await expect(page.locator('.flow-panel .panel-empty')).toBeInViewport({ratio:1})
  await expect.poll(() => page.locator('.person-workspace-drawer').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0)
  await testInfo.attach('empty-collaboration-mobile',{body:await page.screenshot({animations:'disabled'}),contentType:'image/png'})
  expect(errors).toEqual([])
})
