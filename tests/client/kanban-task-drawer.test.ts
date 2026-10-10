// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const mockGetTask = vi.hoisted(() => vi.fn())
const mockListAttachments = vi.hoisted(() => vi.fn())
const mockGetApprovalCapabilities = vi.hoisted(() => vi.fn())
const mockPerformApprovalAction = vi.hoisted(() => vi.fn())
const mockOpenRemotePreview = vi.hoisted(() => vi.fn())
const mockClosePreview = vi.hoisted(() => vi.fn())
const mockRequest = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockArchiveTasks = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockAddComment = vi.hoisted(() => vi.fn())
const mockGetTaskLog = vi.hoisted(() => vi.fn())
const mockGetDiagnostics = vi.hoisted(() => vi.fn())
const mockReclaimTask = vi.hoisted(() => vi.fn())
const mockReassignTask = vi.hoisted(() => vi.fn())
const mockSpecifyTask = vi.hoisted(() => vi.fn())
const mockRouterPush = vi.hoisted(() => vi.fn())
const mockDialogWarning = vi.hoisted(() => vi.fn())
const mockUseMessage = vi.hoisted(() => vi.fn(() => ({
  success: vi.fn(),
  error: vi.fn(),
})))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
}))

vi.mock('@/api/client', () => ({
  request: mockRequest,
}))

vi.mock('@/api/hermes/kanban', () => ({
  getTask: mockGetTask,
  listAttachments: mockListAttachments,
  getApprovalCapabilities: mockGetApprovalCapabilities,
  performApprovalAction: mockPerformApprovalAction,
  getAttachmentContentPath: (taskId: string, attachmentId: number) => `/attachments/${taskId}/${attachmentId}`,
}))

vi.mock('@/stores/hermes/files', () => ({
  useFilesStore: () => ({
    previewFile: null,
    openRemotePreview: mockOpenRemotePreview,
    closePreview: mockClosePreview,
  }),
}))

vi.mock('@/api/studio/binary-content', () => ({
  fetchAuthenticatedBlob: vi.fn(),
  saveBlob: vi.fn(),
}))

vi.mock('@/components/hermes/files/FilePreview.vue', () => ({
  default: defineComponent({
    name: 'FilePreview',
    template: '<div class="file-preview-stub" />',
  }),
}))

vi.mock('@/stores/hermes/kanban', () => ({
  useKanbanStore: () => ({
    selectedBoard: 'project-a',
    assignees: [{ name: 'alice', counts: { todo: 1 } }, { name: 'bob', counts: { ready: 1 } }],
    completeTasks: mockCompleteTasks,
    blockTask: mockBlockTask,
    unblockTasks: mockUnblockTasks,
    archiveTasks: mockArchiveTasks,
    assignTask: mockAssignTask,
    addComment: mockAddComment,
    getTaskLog: mockGetTaskLog,
    getDiagnostics: mockGetDiagnostics,
    reclaimTask: mockReclaimTask,
    reassignTask: mockReassignTask,
    specifyTask: mockSpecifyTask,
  }),
}))

vi.mock('@/components/hermes/chat/HistoryMessageList.vue', () => ({
  default: defineComponent({
    name: 'HistoryMessageList',
    props: { session: { type: Object, required: false } },
    template: '<div class="history-message-list-stub">{{ session ? session.id : "none" }}</div>',
  }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: defineComponent({
    name: 'NDrawer',
    props: { show: { type: Boolean, required: false } },
    emits: ['update:show'],
    template: '<div class="n-drawer-stub"><slot /></div>',
  }),
  NDrawerContent: defineComponent({
    name: 'NDrawerContent',
    props: { title: { type: String, required: false }, closable: { type: Boolean, required: false } },
    template: '<div class="n-drawer-content-stub"><slot /></div>',
  }),
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    template: '<button class="n-button-stub" @click="$emit(\'click\')"><slot /></button>',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: { required: false }, options: { type: Array, default: () => [] } },
    emits: ['update:value'],
    template: '<select class="n-select-stub" @change="$emit(\'update:value\', $event.target.value || null)"><option value=""></option><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    props: { value: { required: false }, size: { type: String, required: false }, placeholder: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
  NModal: defineComponent({
    name: 'NModal',
    props: { show: { type: Boolean, required: false }, title: { type: String, required: false } },
    emits: ['close'],
    template: '<div v-if="show" class="n-modal-stub" :data-title="title"><slot /></div>',
  }),
  useDialog: () => ({
    warning: mockDialogWarning,
  }),
  useMessage: mockUseMessage,
}))

import KanbanTaskDrawer from '@/components/hermes/kanban/KanbanTaskDrawer.vue'

describe('KanbanTaskDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequest.mockResolvedValue({ results: [] })
    mockListAttachments.mockResolvedValue([])
    mockGetApprovalCapabilities.mockResolvedValue({
      can_approve: false,
      allowed_boards: ['project-a'],
      dingtalk_configured: true,
    })
    mockPerformApprovalAction.mockResolvedValue({
      receipt: { event_id: 'evt-1', after_status: 'done', duplicate: false },
    })
    mockOpenRemotePreview.mockResolvedValue(true)
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    mockArchiveTasks.mockResolvedValue(undefined)
    mockAssignTask.mockResolvedValue(undefined)
    mockAddComment.mockResolvedValue({ ok: true })
    mockGetTaskLog.mockResolvedValue({ task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false })
    mockGetDiagnostics.mockResolvedValue([{ task_id: 'task-1' }])
    mockReclaimTask.mockResolvedValue({ ok: true })
    mockReassignTask.mockResolvedValue({ ok: true })
    mockSpecifyTask.mockResolvedValue([{ task_id: 'task-1' }])
    mockGetTask.mockResolvedValue({
      task: {
        id: 'task-1',
        title: 'Ship kanban',
        body: 'Implement feature',
        assignee: 'alice',
        status: 'done',
        priority: 2,
        created_at: 100,
        started_at: 110,
        completed_at: 120,
        tenant: null,
        result: 'Done summary',
      },
      latest_summary: 'Done summary',
      comments: [],
      events: [],
      runs: [{ id: 1, profile: 'alice', status: 'done', started_at: 110, ended_at: 120 }],
      session: {
        id: 'session-1',
        title: 'Hermes session',
        source: 'codex',
        model: 'gpt-5.5',
        started_at: 110,
        ended_at: 120,
        messages: [
          { id: 'm1', role: 'user', content: 'hello', timestamp: 111 },
          { id: 'm2', role: 'assistant', content: 'world', timestamp: 112 },
          { id: 'm3', role: 'tool', content: 'ignore', timestamp: 113 },
        ],
      },
    })
  })

  it('renders completed-result messages through HistoryMessageList', async () => {
    const wrapper = mount(KanbanTaskDrawer, {
      props: { taskId: 'task-1' },
    })

    await flushPromises()

    await wrapper.find('.result-summary').trigger('click')
    await flushPromises()

    const modal = wrapper.find('.n-modal-stub')
    expect(modal.exists()).toBe(true)
    expect(modal.attributes('data-title')).toBe('Ship kanban')

    const history = wrapper.find('.history-message-list-stub')
    expect(history.exists()).toBe(true)
    expect(history.text()).toBe('session-1')

    const sessionProp = wrapper.getComponent({ name: 'HistoryMessageList' }).props('session') as any
    expect(sessionProp.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 111 },
      { id: 'm2', role: 'assistant', content: 'world', timestamp: 112 },
    ])
  })

  it('archives completed tasks from the task drawer', async () => {
    const wrapper = mount(KanbanTaskDrawer, {
      props: { taskId: 'task-1' },
    })
    await flushPromises()

    const archiveButton = wrapper.findAll('.n-button-stub')
      .find(node => node.text() === 'kanban.action.archive')
    expect(archiveButton?.exists()).toBe(true)

    await archiveButton?.trigger('click')
    await flushPromises()

    expect(mockDialogWarning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'kanban.action.archive',
      content: 'kanban.action.archiveConfirm',
      positiveText: 'kanban.action.archive',
      negativeText: 'common.cancel',
    }))
    await mockDialogWarning.mock.calls[0][0].onPositiveClick()
    await flushPromises()

    expect(mockArchiveTasks).toHaveBeenCalledWith(['task-1'])
  })

  it('requires confirmation before archiving through the approval center', async () => {
    mockGetApprovalCapabilities.mockResolvedValueOnce({
      can_approve: true,
      allowed_boards: ['project-a'],
      dingtalk_configured: true,
    })
    const doneDetail = {
      task: {
        id: 'task-approval-archive', title: 'Approved task', body: null, assignee: 'codex-worker',
        status: 'done', priority: 1, created_at: 100, started_at: 110, completed_at: 120, tenant: null,
        result: 'Approved', current_run_id: 17,
      },
      latest_summary: 'Approved', comments: [], events: [], runs: [],
    }
    mockGetTask.mockReset()
    mockGetTask.mockResolvedValueOnce(doneDetail).mockResolvedValueOnce({
      ...doneDetail,
      task: { ...doneDetail.task, status: 'archived' },
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-approval-archive' } })
    await flushPromises()

    await wrapper.find('[data-testid="approval-archive"]').trigger('click')
    await flushPromises()

    expect(mockPerformApprovalAction).not.toHaveBeenCalled()
    expect(mockDialogWarning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'kanban.action.archive',
      content: 'kanban.action.archiveConfirm',
      positiveText: 'kanban.action.archive',
      negativeText: 'common.cancel',
    }))

    await mockDialogWarning.mock.calls[0][0].onPositiveClick()
    await flushPromises()

    expect(mockPerformApprovalAction).toHaveBeenCalledWith(
      'task-approval-archive',
      'archive',
      { reason: undefined },
      { board: 'project-a' },
    )
    expect(mockGetTask).toHaveBeenCalledTimes(2)
  })

  it('shows approval actions by lifecycle status and records the review decision reason', async () => {
    mockGetApprovalCapabilities.mockResolvedValueOnce({
      can_approve: true,
      allowed_boards: ['project-a'],
      dingtalk_configured: true,
    })
    const reviewDetail = {
      task: {
        id: 'task-review', title: 'Risky release', body: 'Breaking migration risk', assignee: 'codex-worker',
        status: 'review', priority: 3, created_at: 100, started_at: 110, completed_at: null, tenant: null,
        result: null, current_run_id: 17,
      },
      latest_summary: 'Ready for review',
      comments: [],
      events: [{ id: 55, task_id: 'task-review', kind: 'review_requested', payload: {}, created_at: 120, run_id: 17 }],
      runs: [{ id: 17, profile: 'codex-worker', status: 'review', started_at: 110, ended_at: 120 }],
    }
    mockGetTask.mockReset()
    mockGetTask.mockResolvedValueOnce(reviewDetail).mockResolvedValueOnce({
      ...reviewDetail,
      task: { ...reviewDetail.task, status: 'done', completed_at: 130 },
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-review' } })
    await flushPromises()

    expect(wrapper.find('[data-testid="approval-risk"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-event-id"]').text()).toContain('55')
    await wrapper.find('[data-testid="approval-reason"]').setValue('tests and diff verified')
    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    await flushPromises()

    expect(mockPerformApprovalAction).toHaveBeenCalledWith(
      'task-review',
      'approve',
      { reason: 'tests and diff verified' },
      { board: 'project-a' },
    )
    expect(mockGetTask).toHaveBeenCalledTimes(2)
  })

  it('hides approval mutations when the Studio identity is not authorized', async () => {
    mockGetApprovalCapabilities.mockResolvedValueOnce({
      can_approve: false,
      allowed_boards: ['project-a'],
      dingtalk_configured: false,
    })
    mockGetTask.mockResolvedValueOnce({
      task: { id: 'task-review', title: 'Review', body: null, assignee: 'codex-worker', status: 'review', priority: 1, created_at: 1, started_at: 2, completed_at: null, tenant: null, result: null },
      latest_summary: null, comments: [], events: [], runs: [],
    })
    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-review' } })
    await flushPromises()

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('kanban.approval.unauthorized')
  })

  it('uses the latest run profile when searching related sessions', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-2',
        title: 'Retry task',
        body: null,
        assignee: 'bob',
        status: 'running',
        priority: 2,
        created_at: 100,
        started_at: 110,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [
        { id: 1, profile: 'stale', status: 'failed', started_at: 110, ended_at: 120 },
        { id: 2, profile: 'fresh', status: 'running', started_at: 130, ended_at: null },
      ],
    })
    mockRequest.mockResolvedValueOnce({
      results: [{ id: 'session-2', title: 'Found session', source: 'codex', model: 'gpt-5.5', started_at: 130 }],
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-2' } })
    await flushPromises()

    const sessionsTitle = wrapper.findAll('.section-title').find(node => node.text() === 'kanban.detail.sessions')
    await sessionsTitle?.trigger('click')
    await flushPromises()

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban/search-sessions?task_id=task-2&profile=fresh&board=project-a')
    await wrapper.find('.session-item').trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith({ name: 'hermes.chat', query: { session: 'session-2' } })
  })

  it('renders task run history through a paged window', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-many-runs',
        title: 'Many runs',
        body: null,
        assignee: 'alice',
        status: 'done',
        priority: 2,
        created_at: 100,
        started_at: 110,
        completed_at: 220,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        task_id: 'task-many-runs',
        profile: `runner-${String(index + 1).padStart(2, '0')}`,
        status: 'done',
        outcome: null,
        summary: `summary-${index + 1}`,
        error: null,
        metadata: null,
        worker_pid: null,
        started_at: 110 + index,
        ended_at: 120 + index,
      })),
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-many-runs' } })
    await flushPromises()

    expect(wrapper.findAll('.run-item')).toHaveLength(10)
    expect(wrapper.text()).toContain('1-10 / 25')
    expect(wrapper.text()).toContain('runner-01')
    expect(wrapper.text()).toContain('runner-10')
    expect(wrapper.text()).not.toContain('runner-11')

    await wrapper.findAll('.n-button-stub').find(node => node.text() === '›')?.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.run-item')).toHaveLength(10)
    expect(wrapper.text()).toContain('11-20 / 25')
    expect(wrapper.text()).not.toContain('runner-10')
    expect(wrapper.text()).toContain('runner-11')
    expect(wrapper.text()).toContain('runner-20')
  })

  it('clears task-scoped operation output when switching tasks', async () => {
    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-1' } })
    await flushPromises()

    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.loadLog')?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('worker log')

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-2',
        title: 'Next task',
        body: null,
        assignee: 'bob',
        status: 'ready',
        priority: 1,
        created_at: 200,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    await wrapper.setProps({ taskId: 'task-2' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('worker log')
  })

  it('does not expose mutation actions for archived tasks', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-archived',
        title: 'Archived task',
        body: null,
        assignee: 'alice',
        status: 'archived',
        priority: 1,
        created_at: 100,
        started_at: 110,
        completed_at: 120,
        tenant: null,
        result: 'Archived summary',
      },
      latest_summary: 'Archived summary',
      comments: [],
      events: [],
      runs: [],
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-archived' } })
    await flushPromises()

    expect(wrapper.text()).not.toContain('kanban.action.complete')
    expect(wrapper.text()).not.toContain('kanban.action.block')
    expect(wrapper.text()).not.toContain('kanban.action.archive')
    expect(wrapper.text()).not.toContain('kanban.action.assign')
  })

  it('uses the 0.19 transition matrix and opens durable attachments in the shared preview', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-scheduled',
        title: 'Scheduled task',
        body: null,
        assignee: 'alice',
        status: 'scheduled',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    mockListAttachments.mockResolvedValueOnce([{
      id: 7,
      filename: 'report.html',
      content_type: 'text/html',
      size: 42,
      uploaded_by: 'alice',
      created_at: 101,
    }])

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-scheduled' } })
    await flushPromises()

    expect(wrapper.text()).toContain('kanban.action.unblock')
    expect(wrapper.text()).not.toContain('kanban.action.complete')
    expect(wrapper.text()).not.toContain('kanban.action.block')

    await wrapper.get('.attachment-item').trigger('click')
    await flushPromises()
    expect(mockOpenRemotePreview).toHaveBeenCalledWith(
      '/attachments/task-scheduled/7',
      'report.html',
      42,
    )
  })

  it('executes complete, block, unblock, and assign actions', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-0',
        title: 'Todo task',
        body: null,
        assignee: null,
        status: 'ready',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    const wrapper = mount(KanbanTaskDrawer, {
      props: { taskId: 'task-0' },
    })
    await flushPromises()

    const buttons = wrapper.findAll('.n-button-stub')
    await buttons.find(node => node.text() === 'kanban.action.complete')?.trigger('click')
    await wrapper.find('.n-input-stub').setValue('done summary')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'common.ok')?.trigger('click')
    await flushPromises()
    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-0'], 'done summary')

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-3',
        title: 'Blocked task',
        body: null,
        assignee: 'alice',
        status: 'blocked',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    await wrapper.setProps({ taskId: 'task-3' })
    await flushPromises()
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.unblock')?.trigger('click')
    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-3'])

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-4',
        title: 'Todo task',
        body: null,
        assignee: null,
        status: 'ready',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-4',
        title: 'Todo task',
        body: null,
        assignee: 'bob',
        status: 'todo',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    await wrapper.setProps({ taskId: 'task-4' })
    await flushPromises()
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.block')?.trigger('click')
    await wrapper.find('.n-input-stub').setValue('waiting dependency')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'common.ok')?.trigger('click')
    expect(mockBlockTask).toHaveBeenCalledWith('task-4', 'waiting dependency')

    const select = wrapper.find('.n-select-stub')
    await select.setValue('bob')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.assign')?.trigger('click')
    await flushPromises()
    expect(mockAssignTask).toHaveBeenCalledWith('task-4', 'bob')
  })
})
