import { describe, it, expect } from 'vitest'
import { foregroundNotification as event, foregroundNotificationPreview, foregroundNotificationAgent } from '../../packages/server/src/modules/studio/services/chat-run/foreground-notification'
describe('foreground notification contract', () => {
  it('uses stable request and run identities without sensitive payload', () => {
    expect(event('approval.requested', { session_id:'s',approval_id:'a',command:'secret' },10)).toEqual({id:'s:approval:a',sessionId:'s',kind:'approval',resolved:false,timestamp:10})
    expect(event('approval.resolved',{session_id:'s',approval_id:'a'},11)?.id).toBe('s:approval:a')
    expect(event('run.completed',{session_id:'s',run_id:'r'},10)?.kind).toBe('completion')
  })
  it('ignores progress, aborts, missing identity and queued/interrupted runs', () => {
    for(const name of ['abort.completed','tool.completed','session.activity']) expect(event(name,{session_id:'s',run_id:'r'})).toBeNull()
    expect(event('run.completed',{session_id:'s'})).toBeNull()
    expect(event('run.completed',{session_id:'s',run_id:'r',queue_remaining:1})).toBeNull()
    expect(event('run.completed',{session_id:'s',run_id:'r',interrupted:true})).toBeNull()
  })
})

 it('ships bounded title and completion preview without command or error payloads', () => {
   expect(foregroundNotificationPreview('completion', {title:'Chat',preview:'fallback'}, {output:'Done\nnow'})).toEqual({title:'Chat',content:'Done now'})
   expect(foregroundNotificationPreview('approval', {title:'Chat'}, {command:'secret',error:'secret'})).toEqual({title:'Chat',content:''})
   expect(foregroundNotificationPreview('completion', {title:'x'.repeat(500)}, {output:'y'.repeat(1000)}).content).toHaveLength(240)
 })

it('normalizes stored agent identity without arbitrary avatar URLs', () => {
 expect(foregroundNotificationAgent('codex')).toBe('codex')
 expect(foregroundNotificationAgent('Claude')).toBe('claude-code')
 expect(foregroundNotificationAgent('ekko')).toBe('ekko-agent')
 expect(foregroundNotificationAgent('cursor')).toBe('cursor')
 expect(foregroundNotificationAgent('https://example/avatar.png')).toBe('')
})
