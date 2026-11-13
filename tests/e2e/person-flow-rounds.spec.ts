import {test,expect} from '@playwright/test'
import {resolve} from 'node:path'
import {mkdir} from 'node:fs/promises'

test('shows bounded and continuous rounds, preserving Stop/Resume controls',async({page})=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message))
  const entry='/@fs/'+resolve('tests/e2e/fixtures/person-flow-rounds.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route('**/__flow_rounds__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`}))
  await page.goto('/__flow_rounds__')
  await expect(page.getByText('第 2/3 轮',{exact:true})).toBeVisible()
  const stop=page.getByRole('button',{name:'停止流程',exact:true})
  await stop.click()
  await expect(page.getByLabel('流程操作')).toHaveText('stop')
  await expect(page.getByText('第 2/3 轮',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'继续',exact:true}).click()
  await expect(page.getByLabel('流程操作')).toHaveText('resume')
  await page.evaluate(()=>(window as any).flowRoundsFixture.continuous())
  await expect(page.getByText('第 2 轮 · 持续至停止',{exact:true})).toBeVisible()
  await page.evaluate(()=>(window as any).flowRoundsFixture.nextRound())
  await expect(page.getByText('第 3 轮 · 持续至停止',{exact:true})).toBeVisible()
  if(process.env.FLOW_ROUNDS_EVIDENCE_DIR){
    await mkdir(process.env.FLOW_ROUNDS_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.FLOW_ROUNDS_EVIDENCE_DIR,'flow-rounds-desktop.png'),fullPage:true})
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:resolve(process.env.FLOW_ROUNDS_EVIDENCE_DIR,'flow-rounds-mobile.png'),fullPage:true})
  }
  await page.evaluate(()=>(window as any).flowRoundsFixture.completed())
  await expect(stop).toHaveCount(0)
  await expect(page.getByText('已完成',{exact:true}).first()).toBeVisible()
  await expect(page.getByRole('button',{name:'重试汇总',exact:true})).toHaveCount(0)
  await expect(page.getByText(/阶段已完成，汇总/)).toHaveCount(0)
  expect(errors).toEqual([])
})
