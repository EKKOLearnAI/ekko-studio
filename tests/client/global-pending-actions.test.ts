// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, reactive } from 'vue'

const chatState = reactive({
  activeSessionId: 'session-a' as string | null,
  pendingApprovals: new Map<string, any>(),
  pendingClarifies: new Map<string, any>(),
  sessions: [] as any[],
  respondApprovalFor: vi.fn(),
  respondToClarifyFor: vi.fn(),
})
const groupState = reactive({
  currentRoomId: 'room-a' as string | null,
  pendingApprovals: new Map<string, any>(),
  pendingClarifies: new Map<string, any>(),
  rooms: [] as any[],
  respondApprovalFor: vi.fn(),
  respondClarifyFor: vi.fn(),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
})
const profileState = reactive({ activeProfileName: 'default' as string | null })
const settingsState = reactive({ display: { approval_bell: false, notify_on_approval: false }, fetchSettings: vi.fn(async () => true) })
const routeState = reactive({ name: 'hermes.chat' as string })
const routerPush = vi.fn(async () => undefined)
const created: any[] = []
const clipboardMock = vi.hoisted(() => ({ copyToClipboard: vi.fn(async () => true) }))
const uiMock = vi.hoisted(() => ({ messageError: vi.fn(), messageWarning: vi.fn() }))
const systemNotificationMock = vi.hoisted(() => ({ showSystemNotification: vi.fn(async () => true) }))
const workflowMock = vi.hoisted(() => ({
  statusHandlers: [] as Array<(status: any) => void>,
  approveWorkflowNode: vi.fn(),
  listWorkflowsSocket: vi.fn(async (_profile?: string) => [{ id: 'workflow-b', name: 'Workflow B' }]),
  subscribeWorkflowStatuses: vi.fn(async (_ids?: string[], _profile?: string) => [] as any[]),
}))

vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatState }))
vi.mock('@/stores/hermes/group-chat', () => ({ useGroupChatStore: () => groupState }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profileState }))
vi.mock('@/stores/hermes/settings', () => ({ useSettingsStore: () => settingsState }))
vi.mock('@/utils/clipboard', () => clipboardMock)
vi.mock('@/utils/completion-notification', () => systemNotificationMock)
vi.mock('@/utils/completion-sound', () => ({ playCompletionSound: vi.fn(async () => true) }))
vi.mock('vue-router', () => ({ useRoute: () => routeState, useRouter: () => ({ push: routerPush }) }))
vi.mock('@/api/studio/workflows', () => ({ approveWorkflowNode: workflowMock.approveWorkflowNode }))
vi.mock('@/api/studio/workflow-socket', () => ({
  listWorkflowsSocket: workflowMock.listWorkflowsSocket,
  subscribeWorkflowStatuses: workflowMock.subscribeWorkflowStatuses,
  disconnectWorkflowSocket: vi.fn(),
  onWorkflowStatusUpdated: vi.fn((handler: (status: any) => void) => { workflowMock.statusHandlers.push(handler); return () => undefined }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', async () => {
  const button = defineComponent({ name: 'NButton', emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' })
  const input = defineComponent({ name: 'NInput', props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' })
  return {
    NButton: button,
    NInput: input,
    useMessage: () => ({ error: uiMock.messageError, warning: uiMock.messageWarning }),
    useNotification: () => ({
      create: vi.fn((options: any) => {
        const entry = { options, destroy: vi.fn() }
        created.push(entry)
        return entry
      }),
    }),
  }
})

import GlobalPendingActions from '@/components/layout/GlobalPendingActions.vue'
import { copyToClipboard } from '@/utils/clipboard'
import { playCompletionSound } from '@/utils/completion-sound'

async function render(node: (() => any) | undefined) {
  const component = defineComponent({ setup: () => () => node?.() })
  return mount(component)
}

function notificationTitleText(entry: any): string {
  const title = typeof entry.options.title === 'function' ? entry.options.title() : entry.options.title
  return typeof title === 'string' ? title : String(title?.children || '')
}

describe('GlobalPendingActions', () => {
  beforeEach(() => {
    created.splice(0)
    chatState.pendingApprovals = new Map()
    chatState.pendingClarifies = new Map()
    chatState.sessions = []
    chatState.activeSessionId = 'session-a'
    groupState.pendingApprovals = new Map()
    groupState.pendingClarifies = new Map()
    groupState.rooms = []
    groupState.currentRoomId = 'room-a'
    profileState.activeProfileName = 'default'
    settingsState.display.approval_bell = false
    settingsState.display.notify_on_approval = false
    routeState.name = 'hermes.chat'
    vi.clearAllMocks()
    settingsState.fetchSettings.mockImplementation(async () => true)
    workflowMock.statusHandlers.splice(0)
  })

  it('sends privacy-safe system notifications for new direct, group, and workflow pending keys with exact navigation', async () => {
    settingsState.display.notify_on_approval = true
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.sessions = [{ id: 'session-b', title: '/secret/path', source: 'global_agent' }]
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'rm -rf /tmp/private', command: 'rm -rf /tmp/private', choices: ['once'],
    }]])
    chatState.pendingClarifies = new Map([['session-c', {
      sessionId: 'session-c', clarifyId: 'clarify-c', question: 'Which secret path?', choices: null,
    }]])
    groupState.pendingApprovals = new Map([['room-b:approval-b', {
      roomId: 'room-b', approvalId: 'approval-b', description: 'Deploy /private', command: 'deploy /private', choices: ['once'],
    }]])
    groupState.pendingClarifies = new Map([['room-c:clarify-c', {
      roomId: 'room-c', clarifyId: 'clarify-c', question: 'Share token?', choices: null,
    }]])
    await nextTick()

    workflowMock.statusHandlers[0]?.({
      workflowId: 'workflow-b', runId: 'run-b', status: 'running',
      pendingApprovals: [{ nodeId: 'build', executionId: 'exec-b' }],
    })
    await nextTick()

    expect(systemNotificationMock.showSystemNotification).toHaveBeenCalledTimes(5)
    for (const [payload] of systemNotificationMock.showSystemNotification.mock.calls) {
      expect(payload.title).toMatch(/^settings\.display\.approvalNotification/)
      expect(payload.body).toMatch(/^settings\.display\.approvalNotification/)
      expect(JSON.stringify(payload)).not.toContain('rm -rf')
      expect(JSON.stringify(payload)).not.toContain('/private')
      expect(JSON.stringify(payload)).not.toContain('Which secret path?')
      expect(JSON.stringify(payload)).not.toContain('Share token?')
    }

    const systemCalls = systemNotificationMock.showSystemNotification.mock.calls as any[][]
    const chatPayload = systemCalls.find(([payload]) => payload.tag.includes('chat-approval'))?.[0]
    expect(chatPayload?.clickUrl).toBe('/hermes/global-agent/session/session-b?profile=default')

    const groupPayload = systemCalls.find(([payload]) => payload.tag.includes('group-approval'))?.[0]
    expect(groupPayload?.clickUrl).toBe('/hermes/group-chat/room/room-b?profile=default')

    const workflowPayload = systemCalls.find(([payload]) => payload.tag.includes('workflow-approval'))?.[0]
    expect(workflowPayload?.clickUrl).toBe('/hermes/workflow?profile=default&workflowId=workflow-b&runId=run-b&nodeId=build&executionId=exec-b')
    wrapper.unmount()
  })

  it('does not send system notifications for restored baseline or repeated authoritative keys', async () => {
    settingsState.display.notify_on_approval = true
    chatState.pendingApprovals = new Map([['restored', {
      sessionId: 'restored', approvalId: 'approval-old', description: 'Old', command: 'old', choices: ['once'],
    }]])
    const wrapper = mount(GlobalPendingActions)
    await nextTick()
    expect(systemNotificationMock.showSystemNotification).not.toHaveBeenCalled()

    chatState.pendingApprovals = new Map([...chatState.pendingApprovals, ['new', {
      sessionId: 'new', approvalId: 'approval-new', description: 'New', command: 'new', choices: ['once'],
    }]])
    await nextTick()
    expect(systemNotificationMock.showSystemNotification).toHaveBeenCalledTimes(1)
    chatState.pendingApprovals = new Map(chatState.pendingApprovals)
    await nextTick()
    expect(systemNotificationMock.showSystemNotification).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('loads persisted display settings when mounted globally', async () => {
    const wrapper = mount(GlobalPendingActions)
    await nextTick()
    expect(settingsState.fetchSettings).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('fences an out-of-order settings load after a Profile switch', async () => {
    const loads: Array<{ options?: { shouldCommit?: () => boolean }; resolve: (value: boolean) => void }> = []
    settingsState.fetchSettings.mockImplementation((options?: { shouldCommit?: () => boolean }) => new Promise<boolean>(resolve => {
      loads.push({ options, resolve })
    }))
    const wrapper = mount(GlobalPendingActions)
    await nextTick()
    expect(loads).toHaveLength(1)

    profileState.activeProfileName = 'research'
    await nextTick()
    expect(loads).toHaveLength(2)
    expect(loads[0].options?.shouldCommit?.()).toBe(false)
    expect(loads[1].options?.shouldCommit?.()).toBe(true)

    settingsState.display.approval_bell = false
    loads[1].resolve(true)
    await Promise.resolve()
    loads[0].resolve(false)
    await Promise.resolve()

    chatState.pendingApprovals = new Map([['research-session', {
      sessionId: 'research-session', approvalId: 'approval-r', description: 'Read config', command: 'read config', choices: ['once'],
    }]])
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('invalidates a pending settings commit when unmounted', async () => {
    let shouldCommit: (() => boolean) | undefined
    settingsState.fetchSettings.mockImplementationOnce((options?: { shouldCommit?: () => boolean }) => {
      shouldCommit = options?.shouldCommit
      return new Promise<boolean>(() => undefined)
    })
    const wrapper = mount(GlobalPendingActions)
    await nextTick()
    expect(shouldCommit?.()).toBe(true)
    wrapper.unmount()
    expect(shouldCommit?.()).toBe(false)
  })

  it('plays a pending new approval after persisted settings finish loading', async () => {
    let resolveSettings!: () => void
    settingsState.fetchSettings.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveSettings = () => resolve(true) }))
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Read config', command: 'read config', choices: ['once'],
    }]])
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()

    settingsState.display.approval_bell = true
    resolveSettings()
    await Promise.resolve()
    await nextTick()
    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not play queued approval sounds when persisted settings fail to load', async () => {
    let resolveSettings!: () => void
    settingsState.fetchSettings.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveSettings = () => resolve(false) }))
    settingsState.display.approval_bell = true
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Read config', command: 'read config', choices: ['once'],
    }]])
    await nextTick()
    resolveSettings()
    await Promise.resolve()
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not play a queued sound when the approval resolves before settings load', async () => {
    let resolveSettings!: () => void
    settingsState.fetchSettings.mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveSettings = () => resolve(true) }))
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Read config', command: 'read config', choices: ['once'],
    }]])
    await nextTick()
    chatState.pendingApprovals = new Map()
    await nextTick()

    settingsState.display.approval_bell = true
    resolveSettings()
    await Promise.resolve()
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('plays the independent approval sound once for each newly surfaced pending action', async () => {
    settingsState.display.approval_bell = true
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Read config', command: 'read config', choices: ['once', 'deny'],
    }]])
    await nextTick()
    expect(playCompletionSound).toHaveBeenCalledTimes(1)

    chatState.pendingApprovals = new Map(chatState.pendingApprovals)
    await nextTick()
    expect(playCompletionSound).toHaveBeenCalledTimes(1)

    groupState.pendingApprovals = new Map([['room-b:approval-b', {
      roomId: 'room-b', approvalId: 'approval-b', description: 'Deploy', command: 'deploy', choices: ['once', 'deny'],
    }]])
    await nextTick()
    expect(playCompletionSound).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not sound for restored pending actions and coalesces a new batch into one sound', async () => {
    settingsState.display.approval_bell = true
    chatState.pendingApprovals = new Map([['restored', {
      sessionId: 'restored', approvalId: 'approval-old', description: 'Old', command: 'old', choices: ['once'],
    }]])
    const wrapper = mount(GlobalPendingActions)
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()

    chatState.pendingApprovals = new Map([
      ...chatState.pendingApprovals,
      ['new-a', { sessionId: 'new-a', approvalId: 'approval-a', description: 'A', command: 'a', choices: ['once'] }],
      ['new-b', { sessionId: 'new-b', approvalId: 'approval-b', description: 'B', command: 'b', choices: ['once'] }],
    ])
    await nextTick()
    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps approval sound independent from completion sound and disabled by default', async () => {
    const wrapper = mount(GlobalPendingActions)
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Read config', command: 'read config', choices: ['once', 'deny'],
    }]])
    await nextTick()
    expect(playCompletionSound).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sounds for new in-context chat requests without duplicating their notifications', async () => {
    settingsState.display.approval_bell = true
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])
    chatState.pendingClarifies = new Map([['session-a', {
      sessionId: 'session-a', clarifyId: 'clarify-a', question: 'Continue?', choices: ['yes', 'no'],
    }]])
    await nextTick()

    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(0)
    wrapper.unmount()
  })

  it('still sends a system notification for a new in-context request when Studio is backgrounded', async () => {
    settingsState.display.notify_on_approval = true
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])
    await nextTick()

    expect(created).toHaveLength(0)
    expect(systemNotificationMock.showSystemNotification).toHaveBeenCalledOnce()
    expect(systemNotificationMock.showSystemNotification).toHaveBeenCalledWith(expect.objectContaining({
      clickUrl: '/hermes/session/session-a?profile=default',
      tag: expect.stringContaining('chat-approval:session-a:approval-a'),
    }))
    wrapper.unmount()
  })

  it('sounds for a new in-context group approval without duplicating its notification', async () => {
    settingsState.display.approval_bell = true
    routeState.name = 'hermes.groupChatRoom'
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    groupState.pendingApprovals = new Map([['room-a:approval-a', {
      roomId: 'room-a', approvalId: 'approval-a', description: 'Deploy', command: 'deploy', choices: ['once'],
    }]])
    await nextTick()

    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(0)
    wrapper.unmount()
  })

  it('does not duplicate the existing in-context approval for the active session', async () => {
    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(created).toHaveLength(0)
  })

  it('shows a stored active-session approval globally when the chat route is not visible', async () => {
    routeState.name = 'hermes.workflow'
    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(created.some(entry => notificationTitleText(entry).includes('session-a'))).toBe(true)
  })

  it('renders the exact approval command as a scrollable code block and copies it', async () => {
    chatState.sessions = [{ id: 'session-b', title: 'branch: branch: Build scripts' }]
    const command = 'rm -rf /tmp/reviewer-snapshot &&\nmkdir -p /tmp/reviewer-snapshot'
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Security scan', command, choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(notificationTitleText(created[0])).toBe('branch: Build scripts · chat.approvalTitle')
    const content = await render(created[0].options.content)
    expect(content.classes()).toContain('global-approval-content')
    expect(content.get('.global-approval-description').text()).toBe('Security scan')
    expect(content.get('.global-approval-command').classes()).toContain('studio-surface')
    const preview = content.get('.global-approval-command')
    expect(preview.get('.global-approval-command-label').text()).toBe('chat.approvalCommand')
    expect(preview.get('pre > code').text()).toBe(command)
    expect(preview.get('pre').attributes('tabindex')).toBe('0')

    await preview.get('button').trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith(command)
    expect(preview.get('button').text()).toBe('common.copied')
  })

  it('reports a failed approval command copy without showing copied feedback', async () => {
    clipboardMock.copyToClipboard.mockResolvedValueOnce(false)
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Security scan', command: 'npm run build', choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const content = await render(created[0].options.content)
    const copyButton = content.get('.global-approval-command button')
    await copyButton.trigger('click')

    expect(copyToClipboard).toHaveBeenCalledWith('npm run build')
    expect(uiMock.messageError).toHaveBeenCalledWith('chat.copyFailed')
    expect(copyButton.text()).toBe('common.copy')
  })

  it('shows and directly handles an approval from an inactive chat session', async () => {
    chatState.sessions = [{ id: 'session-a', title: 'A' }, { id: 'session-b', title: 'B' }]
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Run command', command: 'pwd', choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const approvalNotification = created.find(entry => notificationTitleText(entry).includes('B'))
    expect(approvalNotification).toBeTruthy()
    expect(approvalNotification.options.closable).toBe(false)
    expect(approvalNotification.options.onClose).toBeUndefined()
    const title = await render(approvalNotification.options.title)
    await title.get('button').trigger('click')
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.session', params: { sessionId: 'session-b' } })
    const action = await render(approvalNotification.options.action)
    await action.get('button').trigger('click')
    expect(chatState.respondApprovalFor).toHaveBeenCalledWith('session-b', 'approval-b', 'once')
  })

  it('opens a global-agent session from its notification title', async () => {
    chatState.sessions = [{ id: 'global-session', title: 'Global session', source: 'global_agent' }]
    chatState.pendingApprovals = new Map([['global-session', {
      sessionId: 'global-session', approvalId: 'approval-global', description: 'Run command', command: 'pwd', choices: ['once'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const title = await render(created[0].options.title)
    await title.get('button').trigger('click')
    expect(routerPush).toHaveBeenCalledWith({
      name: 'hermes.globalAgentSession',
      params: { sessionId: 'global-session' },
    })
  })

  it('submits a clarify response from the global notification', async () => {
    chatState.sessions = [{ id: 'session-b', title: 'B' }]
    chatState.pendingClarifies = new Map([['session-b', {
      sessionId: 'session-b', clarifyId: 'clarify-b', question: 'Which environment?', choices: null,
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const content = await render(created[0].options.content)
    await content.get('input').setValue('staging')
    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(chatState.respondToClarifyFor).toHaveBeenCalledWith('session-b', 'clarify-b', 'staging', { q0: 'staging' })
  })

  it('renders every clarify question and submits one answer per question', async () => {
    chatState.sessions = [{ id: 'session-b', title: 'B' }]
    chatState.pendingClarifies = new Map([['session-b', {
      sessionId: 'session-b',
      clarifyId: 'clarify-b',
      question: '1. Which environment?\n2. Which checks?\n3. Anything else?',
      choices: null,
      questions: [
        { qid: 'q0', question: 'Which environment?', choices: ['staging (Recommended)', 'production'], multiSelect: false },
        { qid: 'q1', question: 'Which checks?', choices: ['unit', 'e2e'], multiSelect: true },
        { qid: 'q2', question: 'Anything else?', choices: null, multiSelect: false },
      ],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const content = await render(created[0].options.content)
    expect(content.findAll('.global-clarify-question').map(node => node.text())).toEqual([
      'Which environment?',
      'Which checks?',
      'Anything else?',
    ])
    expect(content.findAll('input')).toHaveLength(3)

    const choiceButtons = content.findAll('.global-clarify-choices button')
    await choiceButtons[1].trigger('click')
    await choiceButtons[2].trigger('click')
    await choiceButtons[3].trigger('click')
    await content.findAll('input')[2].setValue('ship on Friday')

    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(chatState.respondToClarifyFor).toHaveBeenCalledWith(
      'session-b',
      'clarify-b',
      'Which environment? production\nWhich checks? unit, e2e\nAnything else? ship on Friday',
      { q0: 'production', q1: ['unit', 'e2e'], q2: 'ship on Friday' },
    )
  })

  it('warns when a timed-out interaction is closed after an attempted response', async () => {
    mount(GlobalPendingActions)
    window.dispatchEvent(new CustomEvent('hermes:pending-interaction-expired'))
    expect(uiMock.messageWarning).toHaveBeenCalledWith('chat.interactionExpired')
  })

  it('opens and responds to a clarification from an inactive group room', async () => {
    groupState.rooms = [{ id: 'room-b', name: 'Room B' }]
    groupState.pendingClarifies = new Map([['room-b:clarify-b', {
      roomId: 'room-b', agentName: 'Builder', clarifyId: 'clarify-b',
      question: 'Which environment?', choices: null, timeoutMs: 300000,
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(notificationTitleText(created[0])).toContain('Room B')
    const title = await render(created[0].options.title)
    await title.get('button').trigger('click')
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.groupChatRoom', params: { roomId: 'room-b' } })
    const content = await render(created[0].options.content)
    await content.get('input').setValue('staging')
    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(groupState.respondClarifyFor).toHaveBeenCalledWith('room-b', 'clarify-b', 'staging')
  })

  it('opens the source room from the title and handles its approval in place', async () => {
    groupState.rooms = [{ id: 'room-b', name: 'Room B' }]
    groupState.pendingApprovals = new Map([['approval-b', {
      roomId: 'room-b', approvalId: 'approval-b', agentName: 'Builder', description: 'Install package', command: 'npm ci', choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(groupState.connect).toHaveBeenCalled()
    expect(notificationTitleText(created[0])).toContain('Room B')
    const title = await render(created[0].options.title)
    await title.get('button').trigger('click')
    expect(routerPush).toHaveBeenCalledWith({ name: 'hermes.groupChatRoom', params: { roomId: 'room-b' } })
    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(groupState.respondApprovalFor).toHaveBeenCalledWith('room-b', 'approval-b', 'once')
  })

  it('destroys a global notification when the authoritative pending entry resolves', async () => {
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Run', command: 'pwd', choices: ['once'],
    }]])
    mount(GlobalPendingActions)
    await nextTick()
    const instance = created[0]

    chatState.pendingApprovals = new Map()
    await nextTick()

    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('sounds for a visible workflow approval without duplicating its in-context notification', async () => {
    settingsState.display.approval_bell = true
    routeState.name = 'hermes.workflow'
    const wrapper = mount(GlobalPendingActions)
    await nextTick()

    window.dispatchEvent(new CustomEvent('hermes:workflow-approval-visible', {
      detail: { key: 'workflow-approval:workflow-b:run-b:build:exec-b' },
    }))
    workflowMock.statusHandlers[0]?.({
      workflowId: 'workflow-b', runId: 'run-b', status: 'running',
      nodeStatuses: { build: 'pending_approval' },
      pendingApprovals: [{ nodeId: 'build', executionId: 'exec-b' }],
    })
    await nextTick()

    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(0)

    window.dispatchEvent(new CustomEvent('hermes:workflow-approval-visible', {
      detail: { key: 'workflow-approval:workflow-b:run-b:build:exec-b', visible: false },
    }))
    await nextTick()
    expect(created).toHaveLength(1)
    expect(playCompletionSound).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('directly approves a pending workflow node from the global notification', async () => {
    mount(GlobalPendingActions)
    await nextTick()
    workflowMock.statusHandlers[0]({
      workflowId: 'workflow-b', runId: 'run-b', status: 'pending_approval',
      nodeStatuses: { build: 'pending_approval' },
      pendingApprovals: [{ nodeId: 'build', executionId: 'exec-b' }],
    })
    await nextTick()

    const workflowNotification = created.find(entry => notificationTitleText(entry).includes('Workflow B'))
    expect(workflowNotification).toBeTruthy()
    const action = await render(workflowNotification.options.action)
    const buttons = action.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    expect(workflowMock.approveWorkflowNode).toHaveBeenCalledWith('workflow-b', 'run-b', 'build', true, 'exec-b')
  })

  it('renders every authoritative pending workflow execution without guessing from node sessions', async () => {
    mount(GlobalPendingActions)
    await nextTick()
    workflowMock.statusHandlers[0]?.({
      workflowId: 'workflow-b', runId: 'run-b', status: 'running', nodeStatuses: { build: 'pending_approval' },
      pendingApprovals: [
        { nodeId: 'build', executionId: 'exec-1' },
        { nodeId: 'build', executionId: 'exec-2' },
      ],
      run: { node_sessions: [{ node_id: 'build', sequence: 99, execution_id: 'wrong-exec' }] },
    })
    await nextTick()

    const workflowNotifications = created.filter(entry => notificationTitleText(entry).includes('Workflow B'))
    expect(workflowNotifications).toHaveLength(2)
    const secondAction = await render(workflowNotifications[1].options.action)
    const buttons = secondAction.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    expect(workflowMock.approveWorkflowNode).toHaveBeenCalledWith('workflow-b', 'run-b', 'build', true, 'exec-2')
  })

  it('resubscribes workflow approvals when the active profile changes', async () => {
    mount(GlobalPendingActions)
    await nextTick()
    workflowMock.subscribeWorkflowStatuses.mockClear()

    profileState.activeProfileName = 'research'
    await nextTick()

    expect(workflowMock.subscribeWorkflowStatuses).toHaveBeenCalledWith(undefined, 'research')
  })

  it('ignores delayed workflow results from the previous profile', async () => {
    let resolveOldList!: (records: any[]) => void
    let resolveOldStatuses!: (statuses: any[]) => void
    const oldList = new Promise<any[]>(resolve => { resolveOldList = resolve })
    const oldStatuses = new Promise<any[]>(resolve => { resolveOldStatuses = resolve })
    workflowMock.listWorkflowsSocket.mockImplementation((profile?: string) => profile === 'default'
      ? oldList
      : Promise.resolve([{ id: 'workflow-new', name: 'New Workflow' }]))
    workflowMock.subscribeWorkflowStatuses.mockImplementation((_ids?: string[], profile?: string) => profile === 'default'
      ? oldStatuses
      : Promise.resolve([{ workflowId: 'workflow-new', runId: 'run-new', status: 'pending_approval', pendingApprovals: [{ nodeId: 'new-node', executionId: 'new-exec' }] }]))

    mount(GlobalPendingActions)
    await nextTick()
    profileState.activeProfileName = 'research'
    await nextTick()
    await Promise.resolve()
    resolveOldList([{ id: 'workflow-old', name: 'Old Workflow' }])
    resolveOldStatuses([{ workflowId: 'workflow-old', runId: 'run-old', status: 'pending_approval', pendingApprovals: [{ nodeId: 'old-node', executionId: 'old-exec' }] }])
    await Promise.resolve()
    await nextTick()

    expect(created.some(entry => notificationTitleText(entry).includes('Old Workflow'))).toBe(false)
    expect(created.some(entry => notificationTitleText(entry).includes('New Workflow'))).toBe(true)
  })
})
