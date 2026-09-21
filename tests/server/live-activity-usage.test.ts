import { describe, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

describe('Live Activity recorded usage window',()=>{
 it('excludes historical/future calls, other accounts profiles/sessions, estimates and run summaries',async()=>{
  const db=new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  const {USAGE_TABLE}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  db.exec(`CREATE TABLE ${USAGE_TABLE}(session_id TEXT,profile TEXT,usage_scope TEXT,is_estimated INTEGER,created_at INTEGER,input_tokens INTEGER,output_tokens INTEGER)`)
  const add=db.prepare(`INSERT INTO ${USAGE_TABLE} VALUES(?,?,?,?,?,?,?)`)
  add.run('s','p','model_call',0,10000,20,3);add.run('s','p','model_call',0,11000,30,4)
  for(const row of [['s','p','model_call',0,9000],['s','p','model_call',0,13000],['s','other','model_call',0,10000],['other','p','model_call',0,10000],['s','p','model_call',1,10000],['s','p','run',0,10000]])add.run(...row,999,999)
  const {getLiveActivityUsage}=await import('../../packages/server/src/modules/studio/repositories/live-activity-usage')
  expect(getLiveActivityUsage('s','p',10,12000)).toEqual({inputTokens:50,outputTokens:7})
  expect(getLiveActivityUsage('absent','p',10,12000)).toBeUndefined()
  expect(getLiveActivityUsage('s','p',NaN,12000)).toBeUndefined()
  db.close();vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index');vi.resetModules()
 })
})
