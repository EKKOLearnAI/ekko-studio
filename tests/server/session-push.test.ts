import { describe, expect, it, vi } from 'vitest'
import {
  formatSessionPushContent,
  SessionPushNotifier,
} from '../../packages/server/src/modules/studio/services/social-messages/session-push'
import type { SocialMessageTarget } from '../../packages/server/src/modules/studio/services/social-messages/targets'

function pushTarget(
  platform: SocialMessageTarget['platform'],
  recipient: string,
  updatedAt: string,
): SocialMessageTarget {
  return {
    platform,
    recipient,
    recipientType: platform === 'weixin' ? 'user_id' : 'chat_id',
    updatedAt,
  }
}

describe('session push notifications', () => {
  it('delivers a completed run only to the explicitly active medium', async () => {
    const send = vi.fn().mockResolvedValue({})
    const notifier = new SessionPushNotifier({
      readSession: () => ({
        id: 'session-1',
        user_id: '7',
        push_enabled: 1,
        title: 'One target',
        preview: '',
      } as any),
      readTarget: async () => pushTarget('feishu', 'feishu-chat', '2026-08-23T10:00:00.000Z'),
      readLocale: () => 'zh',
      send,
      now: () => 1_000,
    })

    await expect(notifier.notify('session-1', 'run.completed', {
      run_id: 'run-1',
      output: 'Done',
    }, 'codex')).resolves.toBe(1)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(7, {
      platform: 'feishu',
      recipient: 'feishu-chat',
      recipientType: 'chat_id',
      content: 'Codex 有一条已完成消息，请到 Ekko Studio 查看',
    })
  })

  it('formats privacy-safe status messages for the interacting agent', () => {
    expect(formatSessionPushContent('bridge', 'run.completed', 'zh')).toBe(
      'Hermes 有一条已完成消息，请到 Ekko Studio 查看',
    )
    expect(formatSessionPushContent('ekko', 'approval.requested', 'zh')).toBe(
      'Ekko 有一条待授权消息，请到 Ekko Studio 授权',
    )
    expect(formatSessionPushContent('claude-code', 'clarify.requested', 'zh')).toBe(
      'Claude 有一条待回答消息，请到 Ekko Studio 回答',
    )
    expect(formatSessionPushContent('cursor', 'run.completed', 'zh')).toBe(
      'Cursor 有一条已完成消息，请到 Ekko Studio 查看',
    )
  })

  it('does not send when the user has no active target', async () => {
    const send = vi.fn()
    const notifier = new SessionPushNotifier({
      readSession: () => ({
        id: 'session-1',
        user_id: '7',
        push_enabled: 1,
        title: 'No active target',
        preview: '',
      } as any),
      readTarget: async () => undefined,
      resolveTarget: async () => undefined,
      send,
    })

    await expect(notifier.notify('session-1', 'run.completed', { run_id: 'run-2' })).resolves.toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})
