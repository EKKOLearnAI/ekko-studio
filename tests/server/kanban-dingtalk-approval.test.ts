import { describe, expect, it, vi } from 'vitest'
import {
  buildDingTalkApprovalPayload,
  isDingTalkApprover,
  parseDingTalkApprovalReply,
  sendDingTalkApprovalNotification,
  signDingTalkApprovalBody,
  verifyDingTalkApprovalSignature,
} from '../../packages/server/src/modules/hermes/services/kanban/dingtalk-approval'

describe('kanban DingTalk approval bridge', () => {
  it('builds an instruction-based review notification without claiming interactive buttons work', () => {
    const payload = buildDingTalkApprovalPayload({
      task: { id: 'task-1', title: 'Release quote', priority: 3 },
      board: 'codex-tech',
      eventId: 'evt-1',
      studioUrl: 'http://127.0.0.1:8748/#/hermes/kanban?board=codex-tech',
    })

    expect(payload.msgtype).toBe('markdown')
    expect(payload.markdown.text).toContain('task-1')
    expect(payload.markdown.text).toContain('高风险')
    expect(payload.markdown.text).toContain('批准 task-1 <原因>')
    expect(payload.markdown.text).toContain('退回 task-1 <原因>')
    expect(payload.markdown.text).not.toContain('button')
  })

  it('requires an explicit non-wildcard DingTalk user allowlist', () => {
    expect(isDingTalkApprover('james-staff', 'james-staff,other')).toBe(true)
    expect(isDingTalkApprover('unknown', 'james-staff,other')).toBe(false)
    expect(isDingTalkApprover('james-staff', '')).toBe(false)
    expect(isDingTalkApprover('james-staff', '*')).toBe(false)
  })

  it('verifies callback signatures with timestamp freshness', () => {
    const body = JSON.stringify({ event_id: 'evt-1', action: 'approve' })
    const timestamp = '1720000000'
    const signature = signDingTalkApprovalBody(body, timestamp, 'test-secret')

    expect(verifyDingTalkApprovalSignature(body, timestamp, signature, 'test-secret', 1720000000)).toBe(true)
    expect(verifyDingTalkApprovalSignature(body, timestamp, 'bad', 'test-secret', 1720000000)).toBe(false)
    expect(verifyDingTalkApprovalSignature(body, timestamp, signature, 'test-secret', 1720001000)).toBe(false)
  })

  it('retries transient DingTalk notification failures and distinguishes API acceptance from delivery', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    const sleep = vi.fn(async () => {})

    await expect(sendDingTalkApprovalNotification({ msgtype: 'markdown', markdown: { title: 'Review', text: 'Body' } }, {
      webhookUrl: 'https://example.com/dingtalk',
      fetchImpl: fetchImpl as any,
      maxRetries: 2,
      sleep,
    })).resolves.toEqual({ configured: true, api_accepted: true, attempts: 2, recipient_confirmed: false })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('reports notification as disabled without a configured webhook', async () => {
    await expect(sendDingTalkApprovalNotification({ msgtype: 'markdown', markdown: { title: 'Review', text: 'Body' } }, {
      webhookUrl: '',
    })).resolves.toEqual({ configured: false, api_accepted: false, attempts: 0, recipient_confirmed: false })
  })

  it('parses minimal Chinese approval replies without inventing the target card', () => {
    expect(parseDingTalkApprovalReply('批准 task-1 测试已通过')).toEqual({
      action: 'approve',
      taskId: 'task-1',
      reason: '测试已通过',
    })
    expect(parseDingTalkApprovalReply('退回 task-2 缺少回滚验证')).toEqual({
      action: 'request_changes',
      taskId: 'task-2',
      reason: '缺少回滚验证',
    })
    expect(parseDingTalkApprovalReply('批准')).toBeNull()
  })
})
