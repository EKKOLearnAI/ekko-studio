import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPerformApprovalAction = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/kanban/kanban-service', () => ({
  performApprovalAction: mockPerformApprovalAction,
}))

import { receiveDingTalkKanbanApproval } from '../../packages/server/src/modules/hermes/controllers/kanban-dingtalk-approval'
import { signDingTalkCardCallbackTimestamp } from '../../packages/server/src/modules/hermes/services/kanban/dingtalk-approval'

function context(body: unknown, headers: Record<string, string> = {}) {
  return {
    request: { body },
    status: 200,
    body: undefined,
    get: (name: string) => headers[name.toLowerCase()] || '',
  } as any
}

function callbackBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'actionCallback',
    outTrackId: 'task-1',
    corpId: 'ding-corp',
    userId: 'james-staff',
    content: JSON.stringify({
      cardPrivateData: {
        actionIds: ['approve-button'],
        params: { action: 'approve', board: 'codex-tech' },
      },
    }),
    ...overrides,
  }
}

function signedHeaders(timestamp = String(Date.now()), secret = 'test-api-secret') {
  return {
    'x-ddpaas-signature-timestamp': timestamp,
    'x-ddpaas-signature': signDingTalkCardCallbackTimestamp(timestamp, secret),
  }
}

describe('DingTalk kanban card callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.DINGTALK_APPROVAL_CALLBACK_SECRET = 'test-api-secret'
    process.env.DINGTALK_ALLOWED_USERS = 'james-staff'
    mockPerformApprovalAction.mockResolvedValue({
      ok: true,
      duplicate: false,
      event_id: 'dingtalk-card-event',
      before_status: 'review',
      after_status: 'done',
    })
  })

  it('rejects a bad official signature before reading the task', async () => {
    const headers = signedHeaders()
    headers['x-ddpaas-signature'] = 'bad'
    const ctx = context(callbackBody(), headers)

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(401)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('rejects missing official signature headers before reading the task', async () => {
    const ctx = context(callbackBody())

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(401)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('rejects an expired official signature before reading the task', async () => {
    const timestamp = String(Date.now() - 10 * 60 * 1000)
    const ctx = context(callbackBody(), signedHeaders(timestamp))

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(401)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('fails closed when the callback apiSecret is not configured', async () => {
    delete process.env.DINGTALK_APPROVAL_CALLBACK_SECRET
    const ctx = context(callbackBody(), signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(401)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('rejects unknown DingTalk users and never permits wildcard fallback', async () => {
    process.env.DINGTALK_ALLOWED_USERS = '*'
    const ctx = context(callbackBody({ userId: 'unknown' }), signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(403)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('maps an official approve card payload to the canonical approve transition', async () => {
    const ctx = context(callbackBody(), signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(mockPerformApprovalAction).toHaveBeenCalledWith('task-1', 'approve', {
      actor: 'james-staff',
      board: 'codex-tech',
      channel: 'dingtalk',
      eventId: expect.stringMatching(/^dingtalk-card-[a-f0-9]{64}$/),
      reason: 'Approved via DingTalk card callback',
    })
    expect(ctx.body).toEqual({})
  })

  it('explicitly maps reject to request_changes when a non-empty reason is present', async () => {
    const ctx = context(callbackBody({
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ['reject-button'],
          params: { action: 'reject', board: 'codex-tech', reason: '缺少回滚验证' },
        },
      }),
    }), signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(mockPerformApprovalAction).toHaveBeenCalledWith('task-1', 'request_changes', expect.objectContaining({
      actor: 'james-staff',
      board: 'codex-tech',
      channel: 'dingtalk',
      reason: '缺少回滚验证',
    }))
  })

  it('requires a non-empty reason for request-changes callbacks', async () => {
    const ctx = context(callbackBody({
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ['request-changes'],
          params: { action: 'request-changes', board: 'codex-tech', reason: '   ' },
        },
      }),
    }), signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(400)
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })

  it('derives one stable event id so duplicate card callbacks stay idempotent', async () => {
    const seen = new Set<string>()
    let transitions = 0
    mockPerformApprovalAction.mockImplementation(async (_taskId, _action, options) => {
      const duplicate = seen.has(options.eventId)
      if (!duplicate) {
        seen.add(options.eventId)
        transitions += 1
      }
      return { ok: true, duplicate, before_status: 'review', after_status: 'done' }
    })
    const body = callbackBody()

    await receiveDingTalkKanbanApproval(context(body, signedHeaders()))
    await receiveDingTalkKanbanApproval(context(body, signedHeaders()))

    expect(transitions).toBe(1)
    expect(mockPerformApprovalAction.mock.calls[0][2].eventId).toBe(mockPerformApprovalAction.mock.calls[1][2].eventId)
  })

  it('derives distinct event ids for distinct decisions on the same card action', async () => {
    const withReason = (reason: string) => callbackBody({
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ['approve-button'],
          params: { action: 'approve', board: 'codex-tech', reason },
        },
      }),
    })

    await receiveDingTalkKanbanApproval(context(withReason('tests passed'), signedHeaders()))
    await receiveDingTalkKanbanApproval(context(withReason('risk accepted'), signedHeaders()))

    expect(mockPerformApprovalAction.mock.calls[0][2].eventId).not.toBe(mockPerformApprovalAction.mock.calls[1][2].eventId)
  })

  it.each([
    [{ type: 'actionCallback', outTrackId: 'task-1', userId: 'james-staff', content: '{bad json' }, 'content must be valid JSON'],
    [callbackBody({ type: 'other' }), 'type must be actionCallback'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: [], params: { action: 'approve' } } }) }), 'actionIds must contain exactly one action id'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: ['publish'], params: { action: 'publish' } } }) }), 'action is not supported'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: ['request_changes'], params: { action: 'request_changes', reason: 'retry' } } }) }), 'action is not supported'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: ['approve'], params: { action: 'publish' } } }) }), 'action is not supported'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: ['approve'], params: { action: 'approve', board: 'other' } } }) }), 'only enabled for codex-tech'],
    [callbackBody({ content: JSON.stringify({ cardPrivateData: { actionIds: ['reject'], params: { action: 'reject', reason: 'x'.repeat(2_001) } } }) }), 'reason is too long'],
    [callbackBody({ content: { cardPrivateData: { actionIds: ['approve'], params: { action: 'approve' } } } }), 'content must be a JSON string'],
  ])('rejects malformed or unsupported payloads without a transition', async (body, error) => {
    const ctx = context(body, signedHeaders())

    await receiveDingTalkKanbanApproval(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: expect.stringContaining(error) })
    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
  })
})
