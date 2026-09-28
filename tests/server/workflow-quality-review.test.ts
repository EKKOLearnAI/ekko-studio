import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'
import { config } from '../../packages/server/src/modules/studio/public/config'
import { saveJevSettings, deleteJevSettings } from '../../packages/server/src/modules/studio/services/jev/settings'

const dbRoot=mkdtempSync(join(tmpdir(),'workflow-quality-')); process.env.HERMES_WEB_UI_TEST_DB_DIR=dbRoot
const answer={type:'choice',choice:'needs_improvement',confidence:.95,probabilities:{pass:.02,needs_improvement:.95,unknown:.03}}; const response={model:'jev-test',usage:{},answers:{expected_output:answer,completion_evidence:answer,downstream_readiness:answer}}
async function waitFor(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5))}throw new Error('timeout')}

beforeEach(async()=>{vi.resetModules();vi.stubGlobal('fetch',vi.fn(async()=>Response.json(response))); const {initAllHermesTables}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas'); initAllHermesTables(); await saveJevSettings('default',{apiKey:'key',workflowQualityEnabled:true})})
afterEach(async()=>{vi.unstubAllGlobals();await deleteJevSettings('default')})

describe('workflow JEV quality review',()=>{
  it('records criteria for a completed execution without changing run state',async()=>{
    const store=await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const {scheduleWorkflowQualityReview}=await import('../../packages/server/src/modules/studio/services/workflow/quality-review')
    const run=store.createWorkflowRun({id:'run-q',workflow_id:'wf',profile:'default',status:'running'})
    const session=store.createWorkflowRunNodeSession({id:'ns-q',run_id:run.id,workflow_id:'wf',node_id:'node',execution_id:'node',session_id:'session',status:'running'})
    const completed=store.updateWorkflowRunNodeSession(session.id,{status:'completed',finished_at:Date.now()})!
    scheduleWorkflowQualityReview({run,node:{id:'node',data:{}},nodeSession:completed,input:'do it',output:'done'})
    await waitFor(()=>store.listWorkflowRunQualityEvaluations(run.id).length===1)
    expect(store.listWorkflowRunQualityEvaluations(run.id)[0]).toMatchObject({decision:'needs_improvement',node_session_id:'ns-q'})
    expect(store.getWorkflowRun(run.id)?.status).toBe('running')
  })
  it('does not evaluate failed executions',async()=>{
    const fetchMock=vi.mocked(globalThis.fetch); const store=await import('../../packages/server/src/modules/studio/repositories/workflow-run-store'); const {scheduleWorkflowQualityReview}=await import('../../packages/server/src/modules/studio/services/workflow/quality-review')
    const run=store.createWorkflowRun({id:'run-f',workflow_id:'wf',profile:'default',status:'running'}); const session=store.createWorkflowRunNodeSession({id:'ns-f',run_id:run.id,workflow_id:'wf',node_id:'node',session_id:'s',status:'running'}); const failed=store.updateWorkflowRunNodeSession(session.id,{status:'failed',finished_at:Date.now()})!
    scheduleWorkflowQualityReview({run,node:{id:'node',data:{}},nodeSession:failed,input:'',output:''}); await new Promise(r=>setTimeout(r,20)); expect(fetchMock).not.toHaveBeenCalled()
  })
})
