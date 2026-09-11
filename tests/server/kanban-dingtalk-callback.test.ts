import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPerformApprovalAction = vi.hoisted(() => vi.fn())
const mockVerifySignature = vi.hoisted(() => vi.fn())
const mockIsApprover = vi.hoisted(() => vi.fn())
const mockParseReply = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/kanban/kanban-service', () => ({
  performApprovalAction: mockPerformApprovalAction,
}))

vi.mock('../../packages/server/src/modules/hermes/services/kanban/dingtalk-approval', () => ({
  verifyDingTalkApprovalSignature: mockVerifySignature,
  isDingTalkApprover: mockIsApprover,
  parseDingTalkApprovalReply: mockParseReply,
}))

import { receiveDingTalkKanbanApproval } from '../../packages/server/src/modules/hermes/controllers/kanban-dingtalk-approval'

function context(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    request: { body },
    status: 200,
    body: undefined,
    get: (name: string) => headers[name.toLowerCase()] || '',
  } as any
}

describe('DingTalk kanban approval callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DINGTALK_APPROVAL_CALLBACK_SECRET = 'test-secret'
    process.env.DINGTALK_ALLOWED_USERS = 'james-staff'
    mockVerifySignature.mockReturnValue(true)
    mockIsApprover.mockReturnValue(true)
    mockParseReply.mockReturnValue(null)
    mockPerformApprovalAction.mockResolvedValue({
      ok: true,
      duplicate: false,
      event_id: 'evt-1',
      before_status: 'review',
      after_status: 'done',
    })
  })

  it('rejects unsigned callbacks before reading the task', async () => {
    mockVerifySignature.mockReturnValue(false)
    const ctx = context({ event_id: 'evt-1', task_id: 'task-1', sender_id: 'james-staff', action: 'approve', reason: 'approved' })

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(401)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('rejects unknown DingTalk users and never permits wildcard fallback', async () => {
    mockIsApprover.mockReturnValue(false)
    const ctx = context(
      { event_id: 'evt-1', task_id: 'task-1', sender_id: 'unknown', action: 'approve', reason: 'approved' },
      { 'x-hermes-dingtalk-timestamp': '1720000000', 'x-hermes-dingtalk-signature': 'sig' },
    )

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(403)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('writes an authenticated DingTalk decision back to the same canonical card', async () => {
    const ctx = context(
      { board: 'codex-tech', event_id: 'evt-1', task_id: 'task-1', sender_id: 'james-staff', action: 'approve', reason: 'approved' },
      { 'x-hermes-dingtalk-timestamp': '1720000000', 'x-hermes-dingtalk-signature': 'sig' },
    )

    await receiveDingTalkKanbanApproval(ctx)

    expect(mockPerformApprovalAction).toHaveBeenCalledWith('task-1', 'approve', {
      actor: 'james-staff',
      board: 'codex-tech',
      channel: 'dingtalk',
      eventId: 'evt-1',
      reason: 'approved',
    })
    expect(ctx.body).toEqual({ receipt: expect.objectContaining({ after_status: 'done' }) })
  })

  it('requires a reason for approve and request-changes callbacks', async () => {
    const ctx = context(
      { event_id: 'evt-1', task_id: 'task-1', sender_id: 'james-staff', action: 'request_changes' },
      { 'x-hermes-dingtalk-timestamp': '1720000000', 'x-hermes-dingtalk-signature': 'sig' },
    )

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(400)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('accepts an authenticated short DingTalk reply for the same named card', async () => {
    mockParseReply.mockReturnValue({ action: 'request_changes', taskId: 'task-2', reason: '缺少回滚验证' })
    const ctx = context(
      { board: 'codex-tech', event_id: 'ding-msg-2', sender_id: 'james-staff', text: '退回 task-2 缺少回滚验证' },
      { 'x-hermes-dingtalk-timestamp': '1720000000', 'x-hermes-dingtalk-signature': 'sig' },
    )

    await receiveDingTalkKanbanApproval(ctx)

    expect(mockPerformApprovalAction).toHaveBeenCalledWith('task-2', 'request_changes', {
      actor: 'james-staff', board: 'codex-tech', channel: 'dingtalk', eventId: 'ding-msg-2', reason: '缺少回滚验证',
    })
  })
})
