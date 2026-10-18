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
  async function completedExecution() {
    const store = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const { randomUUID } = await import('node:crypto')
    const run = store.createWorkflowRun({ id: randomUUID(), workflow_id: 'wf', profile: 'default', status: 'running' })
    const session = store.createWorkflowRunNodeSession({ id: randomUUID(), run_id: run.id, workflow_id: 'wf',
      node_id: 'node', execution_id: 'exec', session_id: 'session', status: 'completed' })
    return { store, run, session, input: { run, node: { id: 'node', data: {} }, nodeSession: session, input: 'do it', output: 'done' } }
  }

  it.each(['disabled', 'no-key', 'canceled', 'expired', 'other-profile'])('makes zero provider requests when %s', async reason => {
    const h = await completedExecution()
    const { scheduleWorkflowQualityReview } = await import('../../packages/server/src/modules/studio/services/workflow/quality-review')
    if (reason === 'disabled') await saveJevSettings('default', { workflowQualityEnabled: false })
    if (reason === 'no-key') { await deleteJevSettings('default'); await saveJevSettings('default', { workflowQualityEnabled: true }) }
    if (reason === 'canceled') h.store.updateWorkflowRun(h.run.id, { status: 'canceled' })
    if (reason === 'expired') h.input.run = h.store.updateWorkflowRun(h.run.id, { deadline_at: Date.now() - 1 })!
    if (reason === 'other-profile') h.input.run = { ...h.run, profile: 'other' }
    scheduleWorkflowQualityReview(h.input)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fetch).not.toHaveBeenCalled()
    expect(h.store.listWorkflowRunQualityEvaluations(h.run.id)).toEqual([])
    expect(h.store.getWorkflowRunNodeSession(h.session.id)?.status).toBe('completed')
  })

  it.each(['local-cancel', 'remote-cancel', 'deadline', 'disabled', 'provider-error'])('discards late quality output after %s', async reason => {
    const h = await completedExecution()
    const { scheduleWorkflowQualityReview, cancelWorkflowQualityReviews } = await import('../../packages/server/src/modules/studio/services/workflow/quality-review')
    if (reason === 'deadline') h.input.run = h.store.updateWorkflowRun(h.run.id, { deadline_at: Date.now() + 150 })!
    let release!: (value: Response) => void
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      requestSignal = init?.signal
      return new Promise<Response>(resolve => { release = resolve })
    }))
    scheduleWorkflowQualityReview(h.input)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    if (reason.endsWith('cancel')) h.store.updateWorkflowRun(h.run.id, { status: 'canceled' })
    if (reason === 'local-cancel') cancelWorkflowQualityReviews(h.run.id)
    if (reason === 'disabled') await saveJevSettings('default', { workflowQualityEnabled: false })
    if (reason === 'local-cancel' || reason === 'deadline') await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
    release(reason === 'provider-error' ? new Response('', { status: 503 }) : Response.json(response))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.store.listWorkflowRunQualityEvaluations(h.run.id)).toEqual([])
    expect(h.store.getWorkflowRunNodeSession(h.session.id)?.status).toBe('completed')
  })

  it.each(['completed', 'failed'] as const)('still observes a completed node when its run is %s', async status => {
    const h = await completedExecution()
    h.store.updateWorkflowRun(h.run.id, { status })
    const { scheduleWorkflowQualityReview } = await import('../../packages/server/src/modules/studio/services/workflow/quality-review')
    scheduleWorkflowQualityReview(h.input)
    await waitFor(() => h.store.listWorkflowRunQualityEvaluations(h.run.id).length === 1)
    expect(h.store.getWorkflowRun(h.run.id)?.status).toBe(status)
  })

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
