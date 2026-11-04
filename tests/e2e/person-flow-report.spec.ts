import {test,expect} from '@playwright/test'
import {resolve} from 'node:path'
import {mkdir} from 'node:fs/promises'

test('separates stage completion from summary delivery and retries the summary without rerunning stages',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  const capture=async(name:string)=>{
    if(!process.env.FLOW_REPORT_EVIDENCE_DIR)return
    await mkdir(process.env.FLOW_REPORT_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.FLOW_REPORT_EVIDENCE_DIR,name),fullPage:true,animations:'disabled'})
  }
  const entry='/@fs/'+resolve('tests/e2e/fixtures/person-flow-rounds.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route('**/__flow_reports__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`}))
  await page.goto('/__flow_reports__')
  await page.evaluate(()=>(window as any).flowRoundsFixture.report('failed'))
  await expect(page.getByText('阶段已完成，汇总未送达',{exact:true})).toBeVisible()
  await expect(page.getByText('汇总尝试：5/5',{exact:true})).toBeVisible()
  const retry=page.getByRole('button',{name:'重试汇总',exact:true})
  await capture('summary-failed-light-desktop.png')
  await page.evaluate(()=>(window as any).flowRoundsFixture.saving(true))
  await expect(retry).toBeDisabled()
  await page.evaluate(()=>(window as any).flowRoundsFixture.saving(false))
  await retry.click()
  await expect(page.getByLabel('流程操作')).toHaveText('retry_report')
  await expect(page.getByText('阶段已完成，正在汇总结果',{exact:true})).toBeVisible()
  await expect(page.getByText('第 3/3 轮',{exact:true})).toBeVisible()
  await expect(retry).toHaveCount(0)
  await expect(page.getByRole('button',{name:'停止流程',exact:true})).toHaveCount(0)
  await page.evaluate(()=>(window as any).flowRoundsFixture.report('paused'))
  await expect(page.getByText('阶段已完成，汇总已暂停',{exact:true})).toBeVisible()
  await expect(retry).toBeEnabled()
  await page.evaluate(()=>(window as any).flowRoundsFixture.theme())
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>{
    const root=document.documentElement
    root.classList.add('theme-customized','theme-has-custom-background','theme-card-bg','theme-card-filter','theme-card-radius')
    root.style.setProperty('--theme-card-bg','rgba(24,38,63,0)')
    root.style.setProperty('--theme-card-filter','blur(2px)')
    root.style.setProperty('--theme-card-radius','16px')
    root.style.setProperty('--theme-global-border','rgba(150,160,180,0.4)')
    root.style.setProperty('--theme-card-border','rgba(150,160,180,0)')
    document.body.style.backgroundImage='linear-gradient(135deg,#16263e,#43344c)'
  })
  await expect(retry).toBeInViewport()
  await capture('summary-paused-dark-mobile.png')
  await retry.click()
  await page.evaluate(()=>{
    const root=document.documentElement
    root.classList.remove('theme-customized','theme-has-custom-background','theme-card-bg','theme-card-filter','theme-card-radius')
    for(const key of ['--theme-card-bg','--theme-card-filter','--theme-card-radius','--theme-global-border','--theme-card-border'])root.style.removeProperty(key)
    document.body.style.removeProperty('background-image')
    return (window as any).flowRoundsFixture.theme(false)
  })
  await page.evaluate(()=>(window as any).flowRoundsFixture.report('delivered'))
  await expect(page.getByText('汇总已送达',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'查看成果',exact:true}).click()
  await expect(page.getByLabel('原回复')).toHaveText('person-main-creator:777')
  await capture('summary-delivered-reset-mobile.png')
  await page.evaluate(()=>(window as any).flowRoundsFixture.report('cancelled'))
  await expect(page.getByText('阶段已完成，汇总已取消',{exact:true})).toBeVisible()
  await expect(retry).toHaveCount(0)
  expect(errors).toEqual([])
})
