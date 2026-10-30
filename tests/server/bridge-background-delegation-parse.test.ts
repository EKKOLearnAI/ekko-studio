import { describe, expect, it } from 'vitest'
import { parseBackgroundDelegation } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'

describe('background delegation parsing for the bridge poll gate', () => {
  it('recognizes a background delegate_task dispatch', () => {
    const parsed = parseBackgroundDelegation('delegate_task', JSON.stringify({ mode: 'background', delegation_id: 'd-1', status: 'dispatched' }))
    expect(parsed?.delegationId).toBe('d-1')
  })

  it('recognizes a chat cronjob_manage run dispatched in the background', () => {
    // Shape returned by Hermes cronjob_tools._action_run when the run is dispatched asynchronously.
    const output = JSON.stringify({
      success: true,
      job: { job_id: 'job-9', name: 'e2e-manual', executed: true, execution_mode: 'background', delegation_id: 'deleg-cron-1' },
      note: 'The job is running in the background.',
    })
    const parsed = parseBackgroundDelegation('cronjob_manage', output)
    expect(parsed?.delegationId).toBe('deleg-cron-1')
    expect(parsed?.status).toBe('dispatched')
  })

  it('ignores a synchronous cronjob_manage run and other actions', () => {
    expect(parseBackgroundDelegation('cronjob_manage', JSON.stringify({ success: true, job: { job_id: 'job-9', executed: true } }))).toBeNull()
    expect(parseBackgroundDelegation('cronjob_manage', JSON.stringify({ success: true, job_id: 'job-9', deliver: 'local' }))).toBeNull()
  })
})
