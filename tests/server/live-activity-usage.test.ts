import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

describe('Live Activity recorded usage window',()=>{
 it('excludes historical/future calls, other accounts profiles/sessions, estimates and run summaries',async()=>{
  const db=new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  const {USAGE_TABLE,USAGE_SCHEMA}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  db.exec(`CREATE TABLE ${USAGE_TABLE} (${Object.entries(USAGE_SCHEMA).map(([key, sql]) => `${key} ${sql}`).join(',')})`)
  const add=db.prepare(`INSERT INTO ${USAGE_TABLE}(session_id,profile,usage_scope,is_estimated,created_at,input_tokens,output_tokens) VALUES(?,?,?,?,?,?,?)`)
  add.run('s','p','model_call',0,10000,20,3);add.run('s','p','model_call',0,11000,30,4)
  for(const row of [['s','p','model_call',0,9000],['s','p','model_call',0,13000],['s','other','model_call',0,10000],['other','p','model_call',0,10000],['s','p','model_call',1,10000],['s','p','run',0,10000]])add.run(...row,999,999)
  const {getLiveActivityUsage}=await import('../../packages/server/src/modules/studio/repositories/live-activity-usage')
  expect(getLiveActivityUsage('s','p',10,12000)).toEqual({inputTokens:50,outputTokens:7})
  expect(getLiveActivityUsage('absent','p',10,12000)).toBeUndefined()
  expect(getLiveActivityUsage('s','p',NaN,12000)).toBeUndefined()
  db.close();vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index');vi.resetModules()
 })

 it('includes disjoint Ekko subtask totals without including other run summaries',async()=>{
  const db=new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  try {
   const {USAGE_TABLE,USAGE_SCHEMA}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
   db.exec(`CREATE TABLE ${USAGE_TABLE} (${Object.entries(USAGE_SCHEMA).map(([key, sql]) => `${key} ${sql}`).join(',')})`)
   const add=db.prepare(`INSERT INTO ${USAGE_TABLE}(session_id,profile,usage_scope,source,purpose,is_estimated,created_at,input_tokens,output_tokens) VALUES(?,?,?,?,?,?,?,?,?)`)
   add.run('s','p','model_call','ekko_agent','',0,10000,20,3)
   add.run('s','p','model_call','ekko_agent','ekko-subtask',0,10000,7,1)
   add.run('s','p','run','ekko_agent','ekko-subtask',0,11000,30,4)
   add.run('s','p','run','ekko_agent','ekko-background-subtask',0,12000,40,5)
   for(const row of [
    ['s','p','run','ekko_agent','',0,10000],
    ['s','p','run','coding_agent','ekko-subtask',0,10000],
    ['s','p','run','ekko_agent','ekko-subtask',1,10000],
    ['s','p','run','ekko_agent','ekko-subtask',0,9000],
    ['s','p','run','ekko_agent','ekko-background-subtask',0,13000],
    ['s','other','run','ekko_agent','ekko-subtask',0,10000],
    ['other','p','run','ekko_agent','ekko-background-subtask',0,10000],
   ])add.run(...row,999,999)
   const {getLiveActivityUsage}=await import('../../packages/server/src/modules/studio/repositories/live-activity-usage')
   expect(getLiveActivityUsage('s','p',10,12000)).toEqual({inputTokens:97,outputTokens:13})
  } finally {
   db.close();vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index');vi.resetModules()
  }
 })
})
