import {test,expect} from '@playwright/test'
import {resolve} from 'node:path'
import {mkdir,writeFile} from 'node:fs/promises'

test('shows bounded confirmation, retained reply, explicit blocker and resume without another task',async({page})=>{
  const errors:string[]=[]
  page.on('pageerror',error=>errors.push(error.message))
  const entry='/@fs/'+resolve('tests/e2e/fixtures/person-flow-rounds.ts').replaceAll('\\','/').replace(/^\//,'')
  await page.route('**/__stage_confirmation__',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>`}))
  await page.goto('/__stage_confirmation__')
  await page.evaluate(()=>(window as any).flowRoundsFixture.confirming())
  await expect(page.getByText('确认完成情况',{exact:true})).toBeVisible()
  await expect(page.getByText('完成确认：1/2 次；原回复已保留。',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'查看成果'}).click()
  await expect(page.getByLabel('原回复')).toHaveText('person-main-0:16125')
  await page.evaluate(()=>(window as any).flowRoundsFixture.blocked())
  await expect(page.getByText('完成确认：2/2 次；原回复已保留。',{exact:true})).toBeVisible()
  await expect(page.getByText('请先查看原回复或对话，再点“继续”重新确认，不会重做已保存的任务。',{exact:true})).toBeVisible()
  const resume=page.getByRole('button',{name:'继续',exact:true})
  await expect(resume).toBeVisible()
  if(process.env.STAGE_CONFIRMATION_EVIDENCE_DIR){
    await mkdir(process.env.STAGE_CONFIRMATION_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.STAGE_CONFIRMATION_EVIDENCE_DIR,'confirmation-blocked-light.png'),fullPage:true})
    await page.evaluate(()=>(window as any).flowRoundsFixture.theme())
    await writeFile(resolve(process.env.STAGE_CONFIRMATION_EVIDENCE_DIR,'theme-observation.json'),JSON.stringify(await page.evaluate(()=>({button:document.querySelector('.n-button')?.getAttribute('style'),alert:document.querySelector('.n-alert')?.getAttribute('style')})),null,2))
    await page.setViewportSize({width:390,height:844})
    await page.screenshot({path:resolve(process.env.STAGE_CONFIRMATION_EVIDENCE_DIR,'confirmation-blocked-dark-mobile.png'),fullPage:true})
  }
  await resume.click()
  await expect(page.getByLabel('流程操作')).toHaveText('resume')
  await expect(page.getByText('完成确认：0/2 次；原回复已保留。',{exact:true})).toBeVisible()
  await expect(page.getByText('确认失败：需要补充输入',{exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'查看成果'})).toBeVisible()
  expect(errors).toEqual([])
})
