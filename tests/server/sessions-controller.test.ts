import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const listSessionSummariesMock = vi.fn()
const listSessionSummaryGroupsMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getSessionDetailFromDbWithProfileMock = vi.fn()
const getExactSessionDetailFromDbWithProfileMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const deleteHermesSessionForProfileMock = vi.fn()
const localListSessionsMock = vi.fn()
const localCountSessionsMock = vi.fn()
const localGetSessionDetailMock = vi.fn()
const localSearchSessionsMock = vi.fn()
const localDeleteSessionMock = vi.fn()
const localRenameSessionMock = vi.fn()
const localSetSessionArchivedMock = vi.fn()
const localSetSessionPushEnabledMock = vi.fn()
const localCreateSessionMock = vi.fn()
const localUpdateSessionMock = vi.fn()
const localAddMessagesMock = vi.fn()
const localUpdateSessionStatsMock = vi.fn()
const listSessionCategoriesMock = vi.fn()
const createSessionCategoryMock = vi.fn()
const deleteSessionCategoryMock = vi.fn()
const findSessionCategoryByNameMock = vi.fn()
const getSessionCategoryMock = vi.fn()
const renameSessionCategoryMock = vi.fn()
const setSessionCategoryMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getRecordedUsageSessionIdsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const buildDbExportHistoryMock = vi.fn()
const listUserProfilesMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const bridgeSwitchSessionModelMock = vi.fn()
const bridgeGetRuntimeStateMock = vi.fn()
const emitSessionSettingsUpdatedMock = vi.fn()
const getChatRunServerMock = vi.fn()
const agentStatusMocks = vi.hoisted(() => ({ hermesAvailable: true }))
const codingAgentRunManagerMock = vi.hoisted(() => ({
  stop: vi.fn(),
}))
const invalidateCodingAgentSessionRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/history/conversations-db', () => ({
  listConversationSummariesFromDb: listConversationSummariesFromDbMock,
  getConversationDetailFromDb: getConversationDetailFromDbMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  deleteSessionForProfile: deleteHermesSessionForProfileMock,
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
  listSessionSummaryGroups: listSessionSummaryGroupsMock,
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getSessionDetailFromDbWithProfile: getSessionDetailFromDbWithProfileMock,
  getExactSessionDetailFromDbWithProfile: getExactSessionDetailFromDbWithProfileMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  listSessions: localListSessionsMock,
  countSessions: localCountSessionsMock,
  searchSessions: localSearchSessionsMock,
  getSessionDetail: localGetSessionDetailMock,
  deleteSession: localDeleteSessionMock,
  renameSession: localRenameSessionMock,
  setSessionArchived: localSetSessionArchivedMock,
  setSessionPushEnabled: localSetSessionPushEnabledMock,
  createSession: localCreateSessionMock,
  addMessages: localAddMessagesMock,
  getSession: getSessionMock,
  updateSession: localUpdateSessionMock,
  updateSessionStats: localUpdateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-category-store', () => ({
  SESSION_CATEGORY_NAME_MAX_LENGTH: 40,
  listSessionCategories: listSessionCategoriesMock,
  createSessionCategory: createSessionCategoryMock,
  deleteSessionCategory: deleteSessionCategoryMock,
  findSessionCategoryByName: findSessionCategoryByNameMock,
  getSessionCategory: getSessionCategoryMock,
  normalizeSessionCategoryName: (value: unknown) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '',
  renameSessionCategory: renameSessionCategoryMock,
  setSessionCategory: setSessionCategoryMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  getLocalUsageStats: getLocalUsageStatsMock,
  getRecordedUsageSessionIds: getRecordedUsageSessionIdsMock,
}))

vi.mock('../../packages/server/src/modules/studio/routes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/modules/studio/controllers/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/models/context', () => ({
  getModelContextLength: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileName: getActiveProfileNameMock,
  getActiveProfileDir: () => '/tmp/hermes-test/default',
  getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
  listProfileNamesFromDisk: () => ['default', 'travel'],
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: getActiveProfileNameMock,
  getActiveProfileDir: () => '/tmp/hermes-test/default',
  getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
  listProfileNamesFromDisk: () => ['default', 'travel'],
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    switchSessionModel: bridgeSwitchSessionModelMock,
  })),
  getAgentBridgeManager: vi.fn(() => ({
    getRuntimeState: bridgeGetRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/server-registry', () => ({
  getChatRunServer: getChatRunServerMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/server-registry', () => ({
  getChatRunServer: getChatRunServerMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor/export-compressor', () => ({
  buildDbExportHistory: buildDbExportHistoryMock,
  ExportCompressor: class {
    async compress(messages: any[]) {
      return {
        messages,
        meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
      }
    }
  },
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor/export-compressor', () => ({
  buildDbExportHistory: buildDbExportHistoryMock,
  ExportCompressor: class {
    async compress(messages: any[]) {
      return {
        messages,
        meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
      }
    }
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
  deleteHermesSessionForProfile: deleteHermesSessionForProfileMock,
  getHermesCliSession: getSessionMock,
  getHermesModelContextLength: vi.fn(),
  getHermesSessionDetail: getSessionDetailFromDbMock,
  getHermesSessionDetailForProfile: getSessionDetailFromDbWithProfileMock,
  getHermesSessionDetailPaginatedForProfile: vi.fn(),
  getExactHermesSessionDetailForProfile: getExactSessionDetailFromDbWithProfileMock,
  getHermesUsageStats: getUsageStatsFromDbMock,
  listHermesSessionSummaries: listSessionSummariesMock,
  listHermesSessionSummaryGroups: listSessionSummaryGroupsMock,
  notifyHermesSessionModelChanged: async (sessionId: string, model: string, provider: string, profile?: string) => {
    const state = bridgeGetRuntimeStateMock()
    if (!state.ready || !state.running) return
    await bridgeSwitchSessionModelMock(
      sessionId,
      model,
      provider === 'claude-oauth' ? 'anthropic' : provider,
      profile,
    )
  },
  stopCodingAgentSessionRun: codingAgentRunManagerMock.stop,
  invalidateCodingAgentSessionRuntime: invalidateCodingAgentSessionRuntimeMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => agentStatusMocks.hermesAvailable),
}))

const pinMocks = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), migrate: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/sessions/pins', () => ({
  listSessionPins: pinMocks.list,
  setSessionPin: pinMocks.set,
  migrateSessionPins: pinMocks.migrate,
  SessionPinValidationError: class extends Error {},
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    agentStatusMocks.hermesAvailable = true
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    listSessionSummariesMock.mockReset()
    listSessionSummaryGroupsMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getSessionDetailFromDbWithProfileMock.mockReset()
    getExactSessionDetailFromDbWithProfileMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    getSessionMock.mockReset()
    deleteHermesSessionForProfileMock.mockReset()
    localListSessionsMock.mockReset()
    localCountSessionsMock.mockReset().mockReturnValue(0)
    localGetSessionDetailMock.mockReset()
    localSearchSessionsMock.mockReset()
    localDeleteSessionMock.mockReset()
    localRenameSessionMock.mockReset()
    localSetSessionArchivedMock.mockReset()
    localSetSessionPushEnabledMock.mockReset()
    localCreateSessionMock.mockReset()
    localUpdateSessionMock.mockReset()
    localAddMessagesMock.mockReset()
    localUpdateSessionStatsMock.mockReset()
    emitSessionSettingsUpdatedMock.mockReset()
    getChatRunServerMock.mockReset()
    getChatRunServerMock.mockReturnValue({ emitSessionSettingsUpdated: emitSessionSettingsUpdatedMock })
    listSessionCategoriesMock.mockReset()
    createSessionCategoryMock.mockReset()
    deleteSessionCategoryMock.mockReset()
    findSessionCategoryByNameMock.mockReset()
    getSessionCategoryMock.mockReset()
    renameSessionCategoryMock.mockReset()
    setSessionCategoryMock.mockReset()
    listSessionCategoriesMock.mockReturnValue([])
    findSessionCategoryByNameMock.mockReturnValue(null)
    deleteSessionCategoryMock.mockReturnValue(true)
    setSessionCategoryMock.mockReturnValue(true)
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 0,
      by_model: [],
      by_agent: [],
      by_day: [],
      cost: 0,
      total_api_calls: 0,
    })
    getRecordedUsageSessionIdsMock.mockReset()
    getRecordedUsageSessionIdsMock.mockReturnValue([])
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    buildDbExportHistoryMock.mockReset()
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
    readConfigYamlForProfileMock.mockReset()
    readConfigYamlForProfileMock.mockResolvedValue({ model: { default: 'gpt-default', provider: 'openai' } })
    bridgeSwitchSessionModelMock.mockReset()
    bridgeGetRuntimeStateMock.mockReset()
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: false, running: false, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    codingAgentRunManagerMock.stop.mockReset()
    invalidateCodingAgentSessionRuntimeMock.mockReset()
  })

  it('requires authentication for every pin endpoint', async () => {
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/sessions')
    for (const handler of [ctrl.listPins, ctrl.updatePin, ctrl.migratePins]) {
      const ctx: any = { state: {}, query: {}, request: { body: {} }, params: { id: 'a' } }
      await handler(ctx)
      expect(ctx.status).toBe(401)
    }
  })

  it('denies pin reads and writes outside the authenticated user profiles', async () => {
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/sessions')
    listUserProfilesMock.mockReturnValue([{ profile_name: 'allowed' }])
    for (const handler of [ctrl.listPins, ctrl.updatePin, ctrl.migratePins]) {
      const ctx: any = {
        state: { user: { id: 9, role: 'admin' } }, query: { profile: 'forbidden' },
        request: { body: { pinned: true, pinnedIds: ['a'] } }, params: { id: 'a' },
      }
      await handler(ctx)
      expect(ctx.status).toBe(403)
    }
  })

  it('scopes pins to the authenticated user and requested profile', async () => {
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/sessions')
    pinMocks.set.mockReturnValue(['a'])
    pinMocks.list.mockReturnValue(['a'])
    pinMocks.migrate.mockReturnValue(['a'])
    const ctx: any = {
      state: { user: { id: 7, role: 'super_admin' } }, query: { profile: 'work' },
      request: { body: { pinned: true, pinnedIds: ['a'], userId: 999 } }, params: { id: 'a' },
    }
    await ctrl.updatePin(ctx)
    expect(pinMocks.set).toHaveBeenCalledWith(7, 'work', 'a', true)
    await ctrl.listPins(ctx)
    expect(pinMocks.list).toHaveBeenCalledWith(7, 'work')
    await ctrl.migratePins(ctx)
    expect(pinMocks.migrate).toHaveBeenCalledWith(7, 'work', ['a'])
    expect(ctx.body).toEqual({ pinnedIds: ['a'] })
  })

  it('lists conversations from the local session store', async () => {
    localListSessionsMock.mockReturnValue([{
      id: 'local-conversation',
      source: 'cli',
      model: 'gpt-5',
      title: 'Local',
      started_at: 1,
      ended_at: null,
      last_active: Math.floor(Date.now() / 1000),
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'preview',
      workspace: null,
    }])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 5)
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions[0]).toMatchObject({ id: 'local-conversation', source: 'cli', title: 'Local' })
  })

  it('serves bounded workspace preview bytes from unrestricted local paths while preserving profile authorization', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hermes-workspace-preview-'))
    const outside = await mkdtemp(join(tmpdir(), 'hermes-workspace-preview-outside-'))
    const hermesArtifactWorkspace = '/tmp/hermes-test/research/workspace'
    try {
      const pdfBytes = Buffer.from('%PDF-1.7\npreview')
      await writeFile(join(workspace, 'report.pdf'), pdfBytes)
      await writeFile(join(outside, 'secret.pdf'), Buffer.from('%PDF secret'))
      await symlink(join(outside, 'secret.pdf'), join(workspace, 'escaped.pdf'))
      await writeFile(join(workspace, 'large.pdf'), Buffer.alloc(0))
      await truncate(join(workspace, 'large.pdf'), 50 * 1024 * 1024 + 1)
      await mkdir(hermesArtifactWorkspace, { recursive: true })
      const artifactPath = join(hermesArtifactWorkspace, 'generated.py')
      await writeFile(artifactPath, 'print("generated")\n')
      getSessionMock.mockReturnValue({
        id: 'session-preview',
        workspace,
        profile: 'research',
      })

      const headers: Record<string, string> = {}
      const successCtx: any = {
        params: { id: 'session-preview' },
        query: { path: 'report.pdf' },
        state: { user: { id: 1, role: 'super_admin' } },
        set: (name: string, value: string) => { headers[name] = value },
        body: null,
      }
      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      await mod.readWorkspaceFileContent(successCtx)

      expect(successCtx.body).toEqual(pdfBytes)
      expect(headers).toMatchObject({
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBytes.length),
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      })
      expect(headers['Content-Disposition']).toContain('inline;')

      const artifactHeaders: Record<string, string> = {}
      const artifactCtx: any = {
        params: { id: 'session-preview' },
        query: { path: artifactPath, text: '1' },
        state: { user: { id: 1, role: 'super_admin' } },
        set: (name: string, value: string) => { artifactHeaders[name] = value },
        body: null,
      }
      await mod.readWorkspaceFileContent(artifactCtx)
      expect(artifactCtx.body.toString('utf8')).toBe('print("generated")\n')
      expect(artifactHeaders['Content-Type']).toBe('text/plain; charset=utf-8')

      const absoluteOutsideCtx: any = {
        params: { id: 'session-preview' },
        query: { path: join(outside, 'secret.pdf') },
        state: { user: { id: 1, role: 'super_admin' } },
        set: vi.fn(),
        body: null,
      }
      await mod.readWorkspaceFileContent(absoluteOutsideCtx)
      expect(absoluteOutsideCtx.body).toEqual(Buffer.from('%PDF secret'))

      const traversalCtx: any = {
        params: { id: 'session-preview' },
        query: { path: `../${basename(outside)}/secret.pdf` },
        state: { user: { id: 1, role: 'super_admin' } },
        set: vi.fn(),
        body: null,
      }
      await mod.readWorkspaceFileContent(traversalCtx)
      expect(traversalCtx.body).toEqual(Buffer.from('%PDF secret'))

      const escapedCtx: any = {
        params: { id: 'session-preview' },
        query: { path: 'escaped.pdf' },
        state: { user: { id: 1, role: 'super_admin' } },
        set: vi.fn(),
        body: null,
      }
      await mod.readWorkspaceFileContent(escapedCtx)
      expect(escapedCtx.body).toEqual(Buffer.from('%PDF secret'))

      const absoluteWritePath = join(outside, 'written.txt')
      const writeCtx: any = {
        params: { id: 'session-preview' },
        request: { body: { path: absoluteWritePath, content: 'written outside workspace' } },
        state: { user: { id: 1, role: 'super_admin' } },
        body: null,
      }
      await mod.writeWorkspaceFile(writeCtx)
      expect(writeCtx.body).toMatchObject({ ok: true })
      await expect(readFile(absoluteWritePath, 'utf8')).resolves.toBe('written outside workspace')

      listUserProfilesMock.mockReturnValue([{ profile_name: 'research' }])
      const regularAdminOutsideCtx: any = {
        params: { id: 'session-preview' },
        query: { path: join(outside, 'secret.pdf') },
        state: { user: { id: 2, role: 'admin' } },
        set: vi.fn(),
        body: null,
      }
      await mod.readWorkspaceFileContent(regularAdminOutsideCtx)
      expect(regularAdminOutsideCtx.body).toEqual(Buffer.from('%PDF secret'))

      const oversizedCtx: any = {
        params: { id: 'session-preview' },
        query: { path: 'large.pdf' },
        state: { user: { id: 1, role: 'super_admin' } },
        body: null,
      }
      await mod.readWorkspaceFileContent(oversizedCtx)
      expect(oversizedCtx).toMatchObject({ status: 413, body: { code: 'file_too_large' } })

      listUserProfilesMock.mockReturnValue([{ profile_name: 'travel' }])
      const forbiddenCtx: any = {
        params: { id: 'session-preview' },
        query: { path: 'report.pdf' },
        state: { user: { id: 2, role: 'admin' } },
        body: null,
      }
      await mod.readWorkspaceFileContent(forbiddenCtx)
      expect(forbiddenCtx.status).toBe(403)
      expect(forbiddenCtx.body.error).toContain('research')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
      await rm(hermesArtifactWorkspace, { recursive: true, force: true })
    }
  })

  it('accepts legacy workspace-prefixed paths for session workspace files', async () => {
    const workspace = '/tmp/hermes-test/research/workspace'
    await rm('/tmp/hermes-test', { recursive: true, force: true })
    await mkdir(join(workspace, 'project'), { recursive: true })
    await writeFile(join(workspace, 'project', 'notes.md'), 'hello')
    getSessionMock.mockReturnValue({
      id: 'session-with-workspace',
      profile: 'research',
      workspace,
    })

    try {
      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const listCtx: any = {
        params: { id: 'session-with-workspace' },
        query: { path: 'workspace/project' },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await mod.listWorkspaceFiles(listCtx)

      expect(listCtx.status).toBeUndefined()
      expect(listCtx.body.path).toBe('project')
      expect(listCtx.body.absolutePath).toBe(join(workspace, 'project'))
      expect(listCtx.body.entries).toEqual([
        expect.objectContaining({ name: 'notes.md', path: 'project/notes.md', isDir: false }),
      ])

      const readCtx: any = {
        params: { id: 'session-with-workspace' },
        query: { path: 'workspace/project/notes.md' },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await mod.readWorkspaceFile(readCtx)

      expect(readCtx.status).toBeUndefined()
      expect(readCtx.body).toMatchObject({ content: 'hello', path: 'project/notes.md' })
    } finally {
      await rm('/tmp/hermes-test', { recursive: true, force: true })
    }
  })

  it('keeps already session-relative workspace paths unchanged', async () => {
    const workspace = '/tmp/hermes-test/research/workspace'
    await rm('/tmp/hermes-test', { recursive: true, force: true })
    await mkdir(join(workspace, 'project'), { recursive: true })
    await writeFile(join(workspace, 'project', 'notes.md'), 'hello')
    getSessionMock.mockReturnValue({
      id: 'session-relative-workspace',
      profile: 'research',
      workspace,
    })

    try {
      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const ctx: any = {
        params: { id: 'session-relative-workspace' },
        query: { path: 'project/notes.md' },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await mod.readWorkspaceFile(ctx)

      expect(ctx.status).toBeUndefined()
      expect(ctx.body).toMatchObject({ content: 'hello', path: 'project/notes.md' })
    } finally {
      await rm('/tmp/hermes-test', { recursive: true, force: true })
    }
  })

  it('uses the session profile when no explicit request profile is present', async () => {
    const workspace = '/tmp/hermes-test/research/workspace'
    await rm('/tmp/hermes-test', { recursive: true, force: true })
    await mkdir(join(workspace, 'project'), { recursive: true })
    await writeFile(join(workspace, 'project', 'notes.md'), 'hello')
    getSessionMock.mockReturnValue({
      id: 'session-profile-workspace',
      profile: 'research',
      workspace,
    })

    try {
      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const ctx: any = {
        params: { id: 'session-profile-workspace' },
        query: { path: 'workspace/project/notes.md' },
        state: {},
        body: null,
      }

      await mod.readWorkspaceFile(ctx)

      expect(ctx.status).toBeUndefined()
      expect(ctx.body).toMatchObject({ content: 'hello', path: 'project/notes.md' })
    } finally {
      await rm('/tmp/hermes-test', { recursive: true, force: true })
    }
  })

  it('lists Windows drive roots for the workspace folder picker', async () => {
    const originalPlatform = process.platform
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const readdirMock = vi.fn(async (path: string) => {
      if (path === 'D:\\') {
        return [
          { name: 'Projects', isDirectory: () => true },
          { name: 'notes.txt', isDirectory: () => false },
        ]
      }
      return []
    })

    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.WORKSPACE_BASE
    vi.doMock('fs', () => ({
      existsSync: (path: string) => path === 'C:\\' || path === 'D:\\',
    }))
    vi.doMock('fs/promises', () => ({
      readdir: readdirMock,
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      realpath: vi.fn(async (path: string) => path),
    }))

    try {
      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const rootCtx: any = { query: {}, body: null }

      await mod.listWorkspaceFolders(rootCtx)

      expect(rootCtx.body.folders).toEqual([
        { name: 'C:\\', path: 'C:\\', fullPath: 'C:\\', readonly: true },
        { name: 'D:\\', path: 'D:\\', fullPath: 'D:\\', readonly: true },
      ])

      const driveCtx: any = { query: { path: 'D:\\' }, body: null }
      await mod.listWorkspaceFolders(driveCtx)

      expect(readdirMock).toHaveBeenCalledWith('D:\\', { withFileTypes: true })
      expect(driveCtx.body).toMatchObject({
        base: 'D:\\',
        current: 'D:\\',
        folders: [{ name: 'Projects', path: 'D:\\Projects', fullPath: 'D:\\Projects' }],
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      vi.doUnmock('fs')
      vi.doUnmock('fs/promises')
    }
  })

  it('blocks Windows junction-like workspace folders that escape WORKSPACE_BASE', async () => {
    const originalPlatform = process.platform
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const workspaceBase = await mkdtemp(join(tmpdir(), 'hermes-workspace-win-picker-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'hermes-workspace-win-picker-outside-'))

    try {
      const outsideTarget = join(outsideRoot, 'drive-target')
      const outsideChild = join(outsideTarget, 'project')
      const outsideLink = join(workspaceBase, 'DrivesD')

      await mkdir(outsideChild, { recursive: true })
      await symlink(outsideTarget, outsideLink)
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.WORKSPACE_BASE = workspaceBase

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const rootCtx: any = { query: {}, body: null }
      await mod.listWorkspaceFolders(rootCtx)

      expect(rootCtx.status).toBeUndefined()
      expect(rootCtx.body.folders).not.toContainEqual({
        name: 'DrivesD',
        path: 'DrivesD',
        fullPath: outsideLink,
      })

      const nestedCtx: any = { query: { path: 'DrivesD' }, body: null }
      await mod.listWorkspaceFolders(nestedCtx)

      expect(nestedCtx.status).toBe(403)
      expect(nestedCtx.body).toEqual({ error: 'Access denied' })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('lists symlinked workspace folders that resolve within WORKSPACE_BASE and blocks escaped links', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const workspaceBase = await mkdtemp(join(tmpdir(), 'hermes-workspace-picker-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'hermes-workspace-picker-outside-'))

    try {
      const safeTarget = join(workspaceBase, 'workspace-target')
      const safeChild = join(safeTarget, 'nested-child')
      const safeLink = join(workspaceBase, 'linked-workspace')
      const outsideTarget = join(outsideRoot, 'external-target')
      const outsideLink = join(workspaceBase, 'linked-external')

      await mkdir(safeChild, { recursive: true })
      await mkdir(outsideTarget, { recursive: true })
      await symlink(safeTarget, safeLink)
      await symlink(outsideTarget, outsideLink)
      process.env.WORKSPACE_BASE = workspaceBase

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const rootCtx: any = { query: {}, body: null }
      await mod.listWorkspaceFolders(rootCtx)

      expect(rootCtx.status).toBeUndefined()
      expect(rootCtx.body).toEqual({
        base: workspaceBase,
        current: '',
        folders: [
          { name: 'linked-workspace', path: 'linked-workspace', fullPath: safeLink },
          { name: 'workspace-target', path: 'workspace-target', fullPath: safeTarget },
        ],
      })

      const nestedCtx: any = { query: { path: 'linked-workspace' }, body: null }
      await mod.listWorkspaceFolders(nestedCtx)

      expect(nestedCtx.status).toBeUndefined()
      expect(nestedCtx.body).toEqual({
        base: workspaceBase,
        current: 'linked-workspace',
        folders: [
          { name: 'nested-child', path: 'linked-workspace/nested-child', fullPath: join(safeLink, 'nested-child') },
        ],
      })

      const escapedCtx: any = { query: { path: 'linked-external' }, body: null }
      await mod.listWorkspaceFolders(escapedCtx)

      expect(escapedCtx.status).toBe(403)
      expect(escapedCtx.body).toEqual({ error: 'Access denied' })
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('lists dot-prefixed workspace folders under WORKSPACE_BASE', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const workspaceBase = await mkdtemp(join(tmpdir(), 'hermes-workspace-dot-picker-'))

    try {
      const hermesDir = join(workspaceBase, '.hermes')
      const codexDir = join(workspaceBase, '.codex')
      const hiddenChildDir = join(hermesDir, '.plugins')
      const visibleChildDir = join(hermesDir, 'workspace')

      await mkdir(hiddenChildDir, { recursive: true })
      await mkdir(visibleChildDir, { recursive: true })
      await mkdir(codexDir, { recursive: true })
      process.env.WORKSPACE_BASE = workspaceBase

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const rootCtx: any = { query: {}, body: null }
      await mod.listWorkspaceFolders(rootCtx)

      expect(rootCtx.status).toBeUndefined()
      expect(rootCtx.body).toEqual({
        base: workspaceBase,
        current: '',
        folders: [
          { name: '.codex', path: '.codex', fullPath: codexDir },
          { name: '.hermes', path: '.hermes', fullPath: hermesDir },
        ],
      })

      const nestedCtx: any = { query: { path: '.hermes' }, body: null }
      await mod.listWorkspaceFolders(nestedCtx)

      expect(nestedCtx.status).toBeUndefined()
      expect(nestedCtx.body).toEqual({
        base: workspaceBase,
        current: '.hermes',
        folders: [
          { name: '.plugins', path: '.hermes/.plugins', fullPath: hiddenChildDir },
          { name: 'workspace', path: '.hermes/workspace', fullPath: visibleChildDir },
        ],
      })
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('blocks workspace folder mutations through symlinked ancestors that escape WORKSPACE_BASE', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const workspaceBase = await mkdtemp(join(tmpdir(), 'hermes-workspace-mutation-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'hermes-workspace-mutation-outside-'))

    try {
      const outsideTarget = join(outsideRoot, 'external-target')
      const escapeLink = join(workspaceBase, 'escape-link')

      await mkdir(outsideTarget, { recursive: true })
      await symlink(outsideTarget, escapeLink)
      process.env.WORKSPACE_BASE = workspaceBase

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')

      const createCtx: any = { request: { body: { parentPath: 'escape-link', name: 'created' } }, body: null }
      await mod.createWorkspaceFolder(createCtx)
      expect(createCtx.status).toBe(403)
      expect(createCtx.body).toEqual({ error: 'Access denied' })

      const renameCtx: any = { request: { body: { path: 'escape-link', name: 'renamed-link' } }, body: null }
      await mod.renameWorkspaceFolder(renameCtx)
      expect(renameCtx.status).toBe(403)
      expect(renameCtx.body).toEqual({ error: 'Access denied' })

      const deleteCtx: any = { request: { body: { path: 'escape-link' } }, body: null }
      await mod.deleteWorkspaceFolder(deleteCtx)
      expect(deleteCtx.status).toBe(403)
      expect(deleteCtx.body).toEqual({ error: 'Access denied' })

      const { access } = await import('fs/promises')
      await expect(access(escapeLink)).resolves.toBeUndefined()
      await expect(access(join(outsideTarget, 'created'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(join(workspaceBase, 'renamed-link'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('returns clean session context without tool calls or tool results', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'session-context-1',
      profile: 'default',
      source: 'cli',
      title: 'Context Session',
      messages: [
        { id: 1, role: 'user', content: 'Please inspect the repo', timestamp: 101 },
        {
          id: 2,
          role: 'assistant',
          content: 'I will inspect it.',
          timestamp: 102,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { id: 3, role: 'tool', content: '{"file":"secret tool result"}', timestamp: 103, tool_call_id: 'call-1', tool_name: 'read_file' },
        {
          id: 4,
          role: 'assistant',
          content: '',
          timestamp: 104,
          tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
        },
        { id: 5, role: 'assistant', content: 'The repo has a README.', timestamp: 105, reasoning_content: 'Checked files.' },
        { id: 6, role: 'command', content: '/usage', timestamp: 106 },
      ],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'session-context-1' }, query: {}, body: null }

    await mod.getContext(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('session-context-1')
    expect(ctx.body).toEqual({
      session_id: 'session-context-1',
      profile: 'default',
      source: 'cli',
      title: 'Context Session',
      message_count: 3,
      messages: [
        { id: 1, role: 'user', content: 'Please inspect the repo', timestamp: 101 },
        { id: 2, role: 'assistant', content: 'I will inspect it.', timestamp: 102 },
        { id: 5, role: 'assistant', content: 'The repo has a README.', timestamp: 105, reasoning_content: 'Checked files.' },
      ],
    })
    expect(JSON.stringify(ctx.body)).not.toContain('tool_calls')
    expect(JSON.stringify(ctx.body)).not.toContain('secret tool result')
  })

  it('returns 404 for missing session context', async () => {
    localGetSessionDetailMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'missing-session' }, query: {}, body: null }

    await mod.getContext(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('lists all account-accessible single-chat sessions when only the active profile header is present', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    localListSessionsMock.mockReturnValue([
      {
        id: 'default-session',
        profile: 'default',
        source: 'cli',
        model: 'gpt-5',
        title: 'Default',
        started_at: 1,
        ended_at: null,
        last_active: 3,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'travel-session',
        profile: 'travel',
        source: 'cli',
        model: 'gpt-5',
        title: 'Travel',
        started_at: 2,
        ended_at: null,
        last_active: 4,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'secret-session',
        profile: 'secret',
        source: 'cli',
        model: 'gpt-5',
        title: 'Secret',
        started_at: 3,
        ended_at: null,
        last_active: 5,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: {},
      state: {
        user: { id: 1, role: 'admin' },
        profile: { name: 'travel' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 2000, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: ['default', 'travel'],
      includeArchived: false,
      excludeSessionIds: [],
    })
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['default-session', 'travel-session'])
  })

  it('filters the single-chat session list when profile is explicitly provided', async () => {
    localListSessionsMock.mockReturnValue([])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { profile: 'travel' },
      state: { profile: { name: 'default' } },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: undefined,
      includeArchived: false,
      excludeSessionIds: [],
    })
  })

  it('returns a single-chat page with a lookahead row without changing legacy list responses', async () => {
    localCountSessionsMock.mockReturnValue(5)
    localListSessionsMock.mockReturnValue([
      { id: 'chat-3', profile: 'travel', source: 'cli' },
      { id: 'chat-2', profile: 'travel', source: 'cli' },
      { id: 'chat-1', profile: 'travel', source: 'cli' },
    ])
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { profile: 'travel', offset: '2', limit: '2' }, state: {}, body: null }
    await mod.list(ctx)
    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 3, expect.objectContaining({ offset: 2 }))
    expect(ctx.body).toEqual({
      sessions: [
        expect.objectContaining({ id: 'chat-3' }),
        expect.objectContaining({ id: 'chat-2' }),
      ],
      hasMore: true, offset: 2, limit: 2, total: 5,
    })
    localListSessionsMock.mockReturnValue([{ id: 'chat-1', profile: 'travel', source: 'cli' }])
    ctx.query.offset = '4'
    await mod.list(ctx)
    expect(ctx.body).toMatchObject({ hasMore: false, offset: 4, limit: 2, total: 5 })
    localCountSessionsMock.mockClear()
    delete ctx.query.offset
    await mod.list(ctx)
    expect(ctx.body).not.toHaveProperty('hasMore')
    expect(ctx.body).not.toHaveProperty('total')
    expect(localCountSessionsMock).not.toHaveBeenCalled()
  })

  it.each(['-1', 'NaN', '1.5'])('normalizes invalid single-chat offsets (%s)', async (offset) => {
    localListSessionsMock.mockReturnValue([])
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { offset, limit: '10' }, state: {}, body: null }
    await mod.list(ctx)
    expect(ctx.body).toEqual({ sessions: [], hasMore: false, offset: 0, limit: 10, total: 0 })
  })

  it.each([['7', 7], ['none', null]])('passes category %s and pin filters into the paginated query', async (category, categoryId) => {
    localListSessionsMock.mockReturnValue([])
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { category, offset: '10', limit: '10', exclude: ['pin-a', 'pin-b'] }, state: {}, body: null }
    await mod.list(ctx)
    expect(localListSessionsMock).toHaveBeenLastCalledWith(undefined, undefined, 11, expect.objectContaining({
      categoryId, offset: 10, excludeSessionIds: ['pin-a', 'pin-b'],
    }))
    expect(localCountSessionsMock).toHaveBeenLastCalledWith(undefined, undefined, expect.objectContaining({
      categoryId, excludeSessionIds: ['pin-a', 'pin-b'], includeArchived: false,
    }))
    ctx.query = { include: 'pin-a', offset: '0', limit: '10' }
    await mod.list(ctx)
    expect(localListSessionsMock).toHaveBeenLastCalledWith(undefined, undefined, 11, expect.objectContaining({ includeSessionIds: ['pin-a'] }))
    expect(localCountSessionsMock).toHaveBeenLastCalledWith(undefined, undefined, expect.objectContaining({ includeSessionIds: ['pin-a'] }))
  })

  it('counts only accessible profiles and does not reveal totals for a forbidden explicit profile', async () => {
    localListSessionsMock.mockReturnValue([])
    localCountSessionsMock.mockReturnValue(27)
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }])
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { offset: '0', limit: '10' }, state: { user: { id: 'user-1', role: 'user' } } }
    await mod.list(ctx)
    expect(ctx.body.total).toBe(27)
    expect(localCountSessionsMock).toHaveBeenLastCalledWith(undefined, undefined, expect.objectContaining({ profiles: ['default'] }))
    localCountSessionsMock.mockClear()
    ctx.query.profile = 'travel'
    await mod.list(ctx)
    expect(ctx.body.total).toBe(0)
    expect(localCountSessionsMock).not.toHaveBeenCalled()
  })

  it.each(['invalid', '-1', '1.5'])('rejects invalid session category %s', async category => {
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { category, offset: '0' }, state: {}, body: null }
    await mod.list(ctx)
    expect(ctx.status).toBe(400)
    expect(localListSessionsMock).not.toHaveBeenCalled()
  })

  it('lists only global-agent sessions when requested by source', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { source: 'global_agent' },
      state: {},
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, 'global_agent', 2000, {
      sources: undefined,
      profiles: ['default', 'travel'],
      includeArchived: false,
      excludeSessionIds: [],
    })
    expect(ctx.body.sessions).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('filters archived sessions from the single-chat session list', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'visible-session', profile: 'default', source: 'cli', is_archived: 0 },
      { id: 'archived-session', profile: 'default', source: 'cli', is_archived: 1 },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: {}, state: {}, body: null }
    await mod.list(ctx)

    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['visible-session'])
  })

  it('hides workflow sessions from the default list but allows explicit workflow filtering', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'workflow-1', profile: 'default', source: 'workflow' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const defaultCtx: any = {
      query: {},
      state: {},
      body: null,
    }
    await mod.list(defaultCtx)
    expect(defaultCtx.body.sessions).toEqual([expect.objectContaining({ id: 'chat-1', source: 'cli' })])

    const workflowCtx: any = {
      query: { source: 'workflow' },
      state: {},
      body: null,
    }
    await mod.list(workflowCtx)

    expect(localListSessionsMock).toHaveBeenLastCalledWith(undefined, 'workflow', 2000, {
      sources: undefined,
      profiles: ['default', 'travel'],
      includeArchived: false,
      excludeSessionIds: [],
    })
    expect(workflowCtx.body.sessions).toEqual([expect.objectContaining({ id: 'workflow-1', source: 'workflow' })])
  })

  it('counts visible single-chat sessions with the same filters as the list endpoint', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    localListSessionsMock.mockReturnValue([
      { id: 'default-session', profile: 'default', source: 'cli' },
      { id: 'travel-session', profile: 'travel', source: 'coding_agent' },
      { id: 'archived-session', profile: 'default', source: 'cli', is_archived: 1 },
      { id: 'secret-session', profile: 'secret', source: 'cli' },
      { id: 'unknown-profile-session', profile: 'missing', source: 'cli' },
      { id: 'api-session', profile: 'default', source: 'api_server' },
      { id: 'workflow-session', profile: 'default', source: 'workflow' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: {},
      state: {
        user: { id: 1, role: 'admin' },
      },
      body: null,
    }
    await mod.count(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 2147483647)
    expect(ctx.body).toEqual({ count: 3 })
  })

  it('counts sessions for an explicit profile and source', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'travel-global', profile: 'travel', source: 'global_agent' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { profile: 'travel', source: 'global_agent' },
      state: {},
      body: null,
    }
    await mod.count(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', 'global_agent', 2147483647)
    expect(ctx.body).toEqual({ count: 1 })
  })

  it('marks Hermes history sessions that already exist in the Web UI store', async () => {
    localListSessionsMock.mockReturnValue([{ id: 'cli-1', profile: 'travel' }])
    listSessionSummariesMock.mockResolvedValue([
      {
        id: 'cli-1',
        source: 'cli',
        model: 'gpt-5',
        title: 'Imported',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'cli-2',
        source: 'cli',
        model: 'gpt-5',
        title: 'History only',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000)
    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 2000, 'travel')
    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({ id: 'cli-1', profile: 'travel', webui_imported: true }),
      expect.objectContaining({ id: 'cli-2', profile: 'travel', webui_imported: false }),
    ])
  })

  it.each(['cli', 'api_server'])('keeps archived %s sessions visible in Hermes history', async (source) => {
    localListSessionsMock.mockReturnValue([{ id: `${source}-archived`, profile: 'travel', source, is_archived: 1 }])
    listSessionSummariesMock.mockResolvedValue([
      {
        id: `${source}-archived`,
        source,
        model: 'gpt-5',
        title: 'Archived imported history',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({
        id: `${source}-archived`,
        source,
        profile: 'travel',
        webui_imported: true,
        is_archived: 1,
      }),
    ])
  })

  it('returns the first page of every Hermes history source group', async () => {
    localListSessionsMock.mockReturnValue([])
    listSessionSummaryGroupsMock.mockResolvedValue({
      groups: [
        {
          source: 'cli',
          sessions: [
            { id: 'cli-1', source: 'cli', started_at: 3, last_active: 3 },
            { id: 'cli-2', source: 'cli', started_at: 2, last_active: 2 },
          ],
          total: 3,
          hasMore: true,
        },
        {
          source: 'weixin',
          sessions: [{ id: 'wx-1', source: 'weixin', started_at: 1, last_active: 1 }],
          total: 1,
          hasMore: false,
        },
        {
          source: 'api_server',
          sessions: [{ id: 'api-1', source: 'api_server', started_at: 4, last_active: 4 }],
          total: 1,
          hasMore: false,
        },
      ],
      included: [{ id: 'cli-pinned', source: 'cli', started_at: 1, last_active: 1 }],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { profile: 'travel', limit: '2', include: ['cli-pinned'] },
      state: {},
      body: null,
    }

    await mod.listHermesSessionGroups(ctx)

    expect(listSessionSummaryGroupsMock).toHaveBeenCalledWith(2, 'travel', ['cli-pinned'])
    expect(ctx.body).toEqual({
      groups: [
        expect.objectContaining({ source: 'cli', hasMore: true, sessions: [expect.objectContaining({ id: 'cli-1' }), expect.objectContaining({ id: 'cli-2' })] }),
        expect.objectContaining({ source: 'weixin', hasMore: false, sessions: [expect.objectContaining({ id: 'wx-1' })] }),
        expect.objectContaining({ source: 'api_server', hasMore: false, sessions: [expect.objectContaining({ id: 'api-1' })] }),
      ],
      included: [expect.objectContaining({ id: 'cli-pinned', profile: 'travel' })],
    })
  })

  it('paginates one Hermes history source without mixing other local sources', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'cli-local', source: 'cli', started_at: 4, last_active: 4 },
    ])
    listSessionSummariesMock.mockResolvedValue([
      { id: 'cli-1', source: 'cli', started_at: 5, last_active: 5 },
      { id: 'cli-2', source: 'cli', started_at: 3, last_active: 3 },
      { id: 'cli-3', source: 'cli', started_at: 2, last_active: 2 },
      { id: 'cli-4', source: 'cli', started_at: 1, last_active: 1 },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { profile: 'travel', source: 'cli', offset: '1', limit: '2' },
      state: {},
      body: null,
    }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', 'cli', 4)
    expect(listSessionSummariesMock).toHaveBeenCalledWith('cli', 4, 'travel')
    expect(ctx.body).toMatchObject({
      sessions: [
        expect.objectContaining({ id: 'cli-local' }),
        expect.objectContaining({ id: 'cli-2' }),
      ],
      hasMore: true,
      offset: 1,
      limit: 2,
    })
  })

  it('keeps archived coding-agent sessions visible in Hermes history', async () => {
    localListSessionsMock.mockReturnValue([{
      id: 'codex-archived',
      profile: 'travel',
      source: 'coding_agent',
      agent: 'codex',
      model: 'gpt-5',
      title: 'Archived Codex',
      started_at: 1,
      ended_at: null,
      last_active: 2,
      message_count: 1,
      tool_call_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: '',
      is_archived: 1,
    }])
    listSessionSummariesMock.mockResolvedValue([])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({ id: 'codex-archived', source: 'coding_agent', agent: 'codex', webui_imported: true }),
    ])
  })

  it('archives an existing accessible session', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    localSetSessionArchivedMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'session-1' }, state: {}, body: null }

    await mod.archive(ctx)

    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('session-1', true)
    expect(ctx.body).toEqual({ ok: true })
  })

  it('updates whether an accessible session should be pushed', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', push_enabled: 0 })
    localSetSessionPushEnabledMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { pushEnabled: true } },
      state: {},
      body: null,
    }

    await mod.setPushEnabled(ctx)

    expect(localSetSessionPushEnabledMock).toHaveBeenCalledWith('session-1', true)
    expect(emitSessionSettingsUpdatedMock).toHaveBeenCalledWith('session-1', {
      push_enabled: true,
    })
    expect(ctx.body).toEqual({ ok: true, push_enabled: true })
  })

  it('rejects a non-boolean session push setting', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', push_enabled: 0 })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { pushEnabled: 1 } },
      state: {},
      body: null,
    }

    await mod.setPushEnabled(ctx)

    expect(localSetSessionPushEnabledMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'pushEnabled must be a boolean' })
  })

  it('lists and creates normalized global session categories', async () => {
    const category = { id: 1, name: 'Client Work', created_at: 1, updated_at: 1 }
    listSessionCategoriesMock.mockReturnValue([category])
    createSessionCategoryMock.mockReturnValue(category)
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')

    const listCtx: any = { body: null }
    await mod.listCategories(listCtx)
    expect(listCtx.body).toEqual({ categories: [category] })

    const createCtx: any = { request: { body: { name: '  Client   Work ' } }, body: null }
    await mod.createCategory(createCtx)
    expect(createSessionCategoryMock).toHaveBeenCalledWith('Client Work')
    expect(createCtx.body).toEqual({ category })
  })

  it('renames and deletes an existing global session category', async () => {
    const existing = { id: 1, name: 'Work', created_at: 1, updated_at: 1 }
    const renamed = { ...existing, name: 'Client Work', updated_at: 2 }
    getSessionCategoryMock.mockReturnValue(existing)
    renameSessionCategoryMock.mockReturnValue(renamed)
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')

    const renameCtx: any = { params: { id: '1' }, request: { body: { name: 'Client Work' } }, body: null }
    await mod.renameCategory(renameCtx)
    expect(renameSessionCategoryMock).toHaveBeenCalledWith(1, 'Client Work')
    expect(renameCtx.body).toEqual({ category: renamed })

    const deleteCtx: any = { params: { id: '1' }, body: null }
    await mod.removeCategory(deleteCtx)
    expect(deleteSessionCategoryMock).toHaveBeenCalledWith(1)
    expect(deleteCtx.body).toEqual({ ok: true })
  })

  it('assigns and clears a category on an accessible session', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli' })
    getSessionCategoryMock.mockReturnValue({ id: 1, name: 'Work' })
    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')

    const assignCtx: any = {
      params: { id: 'session-1' },
      request: { body: { categoryId: 1 } },
      state: {},
      body: null,
    }
    await mod.setCategory(assignCtx)
    expect(setSessionCategoryMock).toHaveBeenCalledWith('session-1', 1)
    expect(assignCtx.body).toEqual({ ok: true, category_id: 1 })

    const clearCtx: any = {
      params: { id: 'session-1' },
      request: { body: { categoryId: null } },
      state: {},
      body: null,
    }
    await mod.setCategory(clearCtx)
    expect(setSessionCategoryMock).toHaveBeenCalledWith('session-1', null)
    expect(clearCtx.body).toEqual({ ok: true, category_id: null })
  })

  it('rejects archiving global-agent sessions', async () => {
    getSessionMock.mockReturnValue({ id: 'global-1', profile: 'default', source: 'global_agent' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'global-1' }, state: {}, body: null }

    await mod.archive(ctx)

    expect(localSetSessionArchivedMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Global agent sessions cannot be archived' })
  })

  it('returns 404 when archiving a missing session', async () => {
    getSessionMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'missing' }, state: {}, body: null }

    await mod.archive(ctx)

    expect(localSetSessionArchivedMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('unarchives an existing accessible session', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'coding_agent', is_archived: 1 })
    localSetSessionArchivedMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'session-1' }, state: {}, body: null }

    await mod.unarchive(ctx)

    expect(localSetSessionArchivedMock).toHaveBeenCalledWith('session-1', false)
    expect(ctx.body).toEqual({ ok: true })
  })

  it('returns 404 when unarchiving a missing session', async () => {
    getSessionMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'missing' }, state: {}, body: null }

    await mod.unarchive(ctx)

    expect(localSetSessionArchivedMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('searches all account-accessible single-chat sessions unless profile is explicit', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { q: 'docker', limit: '10' },
      state: { profile: { name: 'travel' } },
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: ['default', 'travel'],
      includeArchived: false,
      excludeSessionIds: [],
    })
    expect(ctx.body.results).toEqual([
      expect.objectContaining({ id: 'global-1', source: 'global_agent' }),
      expect.objectContaining({ id: 'chat-1', source: 'cli' }),
    ])
  })

  it('searches only global-agent sessions when requested by source', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      query: { q: 'docker', source: 'global_agent', limit: '10' },
      state: {},
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10, {
      sources: ['global_agent'],
      profiles: ['default', 'travel'],
      includeArchived: false,
      excludeSessionIds: [],
    })
    expect(ctx.body.results).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('propagates local session store errors for conversation summaries', async () => {
    localListSessionsMock.mockImplementation(() => {
      throw new Error('db unavailable')
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await expect(mod.listConversations(ctx)).rejects.toThrow('db unavailable')
  })

  it('gets conversation messages from the local session store', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'root', role: 'command', content: '/usage', timestamp: 2 },
      ],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [{ id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 }],
      visible_count: 1,
      thread_session_count: 1,
    })
  })

  it('treats missing conversation message arrays as empty', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
    })
  })

  it('returns 404 when local conversation detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Conversation not found' })
  })

  it('prefers local session detail for Hermes history detail when available', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Local complete',
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'local full message', timestamp: 1 },
      ],
    })
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Hermes incomplete',
      messages: [],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'cli-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-1')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'cli-1',
      title: 'Local complete',
      messages: [{ content: 'local full message' }],
    })
  })

  it('falls back to Hermes state.db when local history detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'hermes-1',
      source: 'cli',
      title: 'Hermes detail',
      messages: [
        { id: 1, session_id: 'hermes-1', role: 'user', content: 'from hermes', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'hermes-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'hermes-1',
      title: 'Hermes detail',
      messages: [{ content: 'from hermes' }],
    })
  })

  it('returns 404 without reading state.db or spawning Hermes when local history is missing', async () => {
    agentStatusMocks.hermesAvailable = false
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'missing-session' }, body: null }
    await mod.getHermesSession(ctx)

    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('lists only Studio-local history when Hermes is unavailable', async () => {
    agentStatusMocks.hermesAvailable = false
    localListSessionsMock.mockReturnValue([{
      id: 'local-history',
      profile: 'default',
      source: 'api_server',
      title: 'Local history',
      last_active: 10,
    }])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: {}, body: null }
    await mod.listHermesSessions(ctx)

    expect(listSessionSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions).toEqual([expect.objectContaining({ id: 'local-history' })])
  })

  it('groups only Studio-local history when Hermes is unavailable', async () => {
    agentStatusMocks.hermesAvailable = false
    localListSessionsMock.mockReturnValue([{
      id: 'local-history',
      profile: 'default',
      source: 'api_server',
      title: 'Local history',
      last_active: 10,
    }])

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { limit: '20' }, body: null }
    await mod.listHermesSessionGroups(ctx)

    expect(listSessionSummaryGroupsMock).not.toHaveBeenCalled()
    expect(ctx.body.groups).toEqual([
      expect.objectContaining({
        source: 'api_server',
        sessions: [expect.objectContaining({ id: 'local-history' })],
      }),
    ])
  })

  it('reads Hermes history detail from the requested profile database', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'travel-session',
      source: 'cli',
      title: 'Travel detail',
      messages: [
        { id: 1, session_id: 'travel-session', role: 'user', content: 'from travel', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'travel-session' }, query: { profile: 'travel' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('travel-session')
    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'travel-session',
      profile: 'travel',
      title: 'Travel detail',
      messages: [{ content: 'from travel' }],
    })
  })

  it('returns api_server sessions from the local store in Hermes history', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'api-1',
      source: 'api_server',
      title: 'API Server',
      messages: [{ id: 1, session_id: 'api-1', role: 'user', content: 'local api', timestamp: 1 }],
    })
    getSessionDetailFromDbMock.mockResolvedValue(null)
    getSessionMock.mockResolvedValue(null)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'api-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('api-1')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'api-1',
      source: 'api_server',
      title: 'API Server',
      messages: [{ content: 'local api' }],
    })
  })

  it('merges local usage with only state.db sessions missing from the local ledger', async () => {
    const today = new Date().toISOString().slice(0, 10)
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      sessions: 1,
      by_model: [
        { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_agent: [
        { agent: 'codex', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_day: [
        { date: today, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, sessions: 1, errors: 0, cost: 0 },
      ],
      cost: 0,
      total_api_calls: 2,
    })
    getRecordedUsageSessionIdsMock.mockReturnValue(['local-session'])
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 6,
      sessions: 2,
      cost: 0.02,
      total_api_calls: 7,
      by_model: [
        { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_agent: [
        { agent: 'hermes', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_day: [
        { date: today, input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, sessions: 2, errors: 0, cost: 0.02 },
      ],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('default', 2)
    expect(getRecordedUsageSessionIdsMock).toHaveBeenCalledWith('default')
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2, undefined, 'default', ['local-session'])
    expect(ctx.body).toMatchObject({
      total_input_tokens: 30,
      total_output_tokens: 15,
      total_cache_read_tokens: 6,
      total_cache_write_tokens: 3,
      total_reasoning_tokens: 9,
      total_sessions: 3,
      total_cost: 0.02,
      total_api_calls: 9,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
    ])
    expect(ctx.body.agent_usage).toEqual([
      { agent: 'hermes', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      { agent: 'codex', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
      cache_read_tokens: 6,
      cache_write_tokens: 3,
      sessions: 3,
      cost: 0.02,
    })
  })

  it('loads usage analytics from the request-scoped profile state database', async () => {
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 12,
      output_tokens: 6,
      cache_read_tokens: 3,
      cache_write_tokens: 1,
      reasoning_tokens: 2,
      sessions: 1,
      cost: 0.01,
      total_api_calls: 4,
      by_model: [
        { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { days: '2' }, state: { profile: { name: 'research' } }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).toHaveBeenCalledWith('research', 2)
    expect(getRecordedUsageSessionIdsMock).toHaveBeenCalledWith('research')
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2, undefined, 'research', [])
    expect(ctx.body).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 6,
      total_sessions: 1,
      total_cost: 0.01,
      total_api_calls: 4,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
    ])
  })

  it('keeps blank model usage as returned by state.db analytics', async () => {
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 1,
      by_model: [
        { model: '', input_tokens: 3, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
      cost: 0,
      total_api_calls: 1,
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_tokens: 1,
      cache_write_tokens: 1,
      reasoning_tokens: 0,
      sessions: 1,
      cost: 0,
      total_api_calls: 0,
      by_model: [
        { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(ctx.body.model_usage).toEqual([
      { model: '', input_tokens: 5, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 2 },
    ])
  })

  it('sets a session model and provider in the local session store', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'grok-4', provider: 'xai' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localCreateSessionMock).not.toHaveBeenCalled()
    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'grok-4',
      provider: 'xai',
      reasoning_effort: '',
      workspace: '/tmp/hermes-test/default/workspace',
    })
    expect(emitSessionSettingsUpdatedMock).toHaveBeenCalledWith('session-1', {
      model: 'grok-4',
      provider: 'xai',
      api_mode: '',
      reasoning_effort: '',
    })
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('notifies a loaded agent bridge session after storing the session model', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeSwitchSessionModelMock.mockResolvedValue({
      ok: true,
      session_id: 'session-1',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      loaded: true,
      switched: true,
    })
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'travel' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'claude-sonnet-4-6', provider: 'claude-oauth' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'claude-sonnet-4-6',
      provider: 'claude-oauth',
      reasoning_effort: '',
      workspace: '/tmp/hermes-test/travel/workspace',
    })
    expect(bridgeSwitchSessionModelMock).toHaveBeenCalledWith(
      'session-1',
      'claude-sonnet-4-6',
      'anthropic',
      'travel',
    )
    expect(ctx.body).toEqual({ ok: true })
  })

  it('stores a coding agent session model and API mode without stopping the runner or notifying the Hermes bridge', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      model: 'old-model',
      provider: 'openrouter',
      api_mode: 'codex_responses',
      agent_native_session_id: 'old-native-thread',
      workspace: '/tmp/original-workspace',
    })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'codex-session' },
      request: { body: { model: 'gpt-5.5', provider: 'openai-codex', apiMode: 'chat_completions' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('codex-session', {
      model: 'gpt-5.5',
      provider: 'openai-codex',
      reasoning_effort: '',
      api_mode: 'chat_completions',
      agent_native_session_id: '',
    })
    expect(codingAgentRunManagerMock.stop).not.toHaveBeenCalled()
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('persists and broadcasts a session reasoning effort', async () => {
    getSessionMock.mockReturnValue({ id: 'session-reasoning', profile: 'default' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      params: { id: 'session-reasoning' },
      request: { body: { reasoningEffort: 'high' } },
      body: null,
    }
    await mod.setReasoningEffort(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-reasoning', {
      reasoning_effort: 'high',
    })
    expect(emitSessionSettingsUpdatedMock).toHaveBeenCalledWith('session-reasoning', {
      reasoning_effort: 'high',
    })
    expect(ctx.body).toEqual({ ok: true, reasoning_effort: 'high' })
  })

  it('restarts a Grok runtime after changing session reasoning effort', async () => {
    getSessionMock.mockReturnValue({ id: 'grok-session', profile: 'default', agent: 'grok' })

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    await mod.setReasoningEffort({
      params: { id: 'grok-session' },
      request: { body: { reasoningEffort: 'max' } },
      body: null,
    } as any)

    expect(invalidateCodingAgentSessionRuntimeMock).toHaveBeenCalledWith('grok-session')
  })

  it('deletes a current-profile Hermes history session even when no local Web UI session exists', async () => {
    getActiveProfileNameMock.mockReturnValue('travel')
    getSessionMock.mockReturnValue(null)
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'history-only', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'history-only' }, body: null }
    await mod.remove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(localDeleteSessionMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      ok: true,
      deleted: false,
      hermes: { attempted: true, deleted: true, profile: 'travel', error: undefined },
    })
  })

  it('deletes a local coding-agent session without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'codex-session' }, body: null }
    await mod.remove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toEqual({
      ok: true,
      deleted: true,
      hermes: { attempted: false, deleted: false, profile: 'default' },
    })
  })

  it('batch deletes sessions from their requested profiles', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    getSessionMock.mockImplementation((id: string) => ({
      id,
      profile: id === 'travel-session' ? 'travel' : 'default',
    }))
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'matched', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [
            { id: 'default-session', profile: 'default' },
            { id: 'travel-session', profile: 'travel' },
          ],
        },
      },
      state: {
        user: { id: 1, role: 'admin' },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('default-session')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('travel-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 2, failed: 0, hermesDeleted: 2 })
  })

  it('batch deletes local coding-agent sessions without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [{ id: 'codex-session', profile: 'default' }],
        },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 1, failed: 0, hermesDeleted: 0 })
  })

  it('imports a Hermes session into the local Web UI store', async () => {
    const hermesDetail = {
      id: 'cli-1',
      source: 'cli',
      user_id: null,
      model: 'gpt-5',
      title: 'CLI run',
      started_at: 100,
      ended_at: 200,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'hello',
      last_active: 200,
      thread_session_count: 1,
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'cli-1', role: 'assistant', content: 'hi', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null, reasoning_details: { text: 'ok' } },
        { id: 3, session_id: 'cli-1', role: 'assistant', content: '', tool_call_id: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: { path: 'README.md' } } }], tool_name: null, timestamp: 102, token_count: null, finish_reason: 'tool_calls', reasoning: null },
        { id: 4, session_id: 'cli-1', role: 'tool', content: { ok: true }, tool_call_id: 'call-1', tool_calls: null, tool_name: 'read_file', timestamp: 103, token_count: null, finish_reason: null, reasoning: null },
        { id: 5, session_id: 'cli-1', role: 'tool', content: 'orphan', tool_call_id: null, tool_calls: null, tool_name: 'bad_tool', timestamp: 104, token_count: null, finish_reason: null, reasoning: null },
        { id: 6, session_id: 'cli-1', role: 'system', content: 'drop me', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 105, token_count: null, finish_reason: null, reasoning: null },
      ],
    }
    localGetSessionDetailMock.mockReturnValueOnce(null).mockReturnValueOnce({ ...hermesDetail, profile: 'travel' })
    getSessionDetailFromDbWithProfileMock.mockResolvedValue(hermesDetail)

    const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx: any = { params: { id: 'cli-1' }, query: { profile: 'travel' }, state: {}, body: null }

    await mod.importHermesSession(ctx)

    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('cli-1', 'travel')
    expect(localCreateSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cli-1',
      profile: 'travel',
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
      title: 'CLI run',
    }))
    expect(localUpdateSessionMock).toHaveBeenCalledWith('cli-1', expect.objectContaining({
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
    }))
    expect(localAddMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({ session_id: 'cli-1', role: 'user', content: 'hello', tool_calls: null }),
      expect.objectContaining({ session_id: 'cli-1', role: 'assistant', content: 'hi', reasoning_details: '{"text":"ok"}' }),
      expect.objectContaining({
        session_id: 'cli-1',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      }),
      expect.objectContaining({ session_id: 'cli-1', role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', tool_name: 'read_file' }),
    ])
    expect(localUpdateSessionStatsMock).toHaveBeenCalledWith('cli-1')
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      last_active: expect.any(Number),
    }))
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1].last_active).toBeGreaterThan(200)
    expect(ctx.body).toMatchObject({ ok: true, imported: true })
  })

  describe('exportSession', () => {
    it('returns session as JSON download with correct headers (full mode)', async () => {
      const sessionData = { id: 'abc-123', title: 'Test Session', messages: [{ id: 1, role: 'user', content: 'hello' }] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'abc-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('abc-123')
      expect(setMock).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('abc-123'))
      expect(setMock).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.status).toBeUndefined()
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'abc-123', title: 'Test Session' })
    })

    it('returns full TXT export', async () => {
      const sessionData = {
        id: 'txt-123',
        title: 'Text Export',
        messages: [
          { id: 1, role: 'user', content: 'hello', timestamp: 1700000000 },
          { id: 2, role: 'assistant', content: 'hi', timestamp: 1700000001 },
        ],
      }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'txt-123' }, query: { mode: 'full', ext: 'txt' }, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(setMock).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8')
      expect(ctx.body).toContain('# Text Export')
      expect(ctx.body).toContain('[user]')
      expect(ctx.body).toContain('hello')
      expect(ctx.body).toContain('[assistant]')
      expect(ctx.body).toContain('hi')
    })

    it('uses snapshot-aware DB history for compressed export without loading full session detail', async () => {
      getSessionMock.mockReturnValue({
        id: 'compressed-123',
        title: 'Compressed Export',
        profile: 'default',
        model: 'gpt-test',
        provider: 'openai',
      })
      buildDbExportHistoryMock.mockReturnValue([
        { role: 'user', content: 'protected head' },
        { role: 'assistant', content: 'post cursor' },
      ])

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const ctx: any = {
        params: { id: 'compressed-123' },
        query: { mode: 'compressed', ext: 'json' },
        set: vi.fn(),
        body: null,
      }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).not.toHaveBeenCalled()
      expect(buildDbExportHistoryMock).toHaveBeenCalledWith('compressed-123')
      expect(JSON.parse(ctx.body).messages).toEqual([
        { role: 'user', content: 'protected head' },
        { role: 'assistant', content: 'post cursor' },
      ])
    })

    it('returns 404 when session not found', async () => {
      localGetSessionDetailMock.mockReturnValue(null)
      getSessionMock.mockResolvedValue(null)

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const ctx: any = { params: { id: 'not-found' }, query: {}, set: vi.fn(), body: null }

      await mod.exportSession(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Session not found' })
    })

    it('falls back to CLI when DB query fails', async () => {
      const sessionData = { id: 'cli-123', title: 'CLI Session', messages: [] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/modules/studio/controllers/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'cli-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-123')
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'cli-123' })
    })
  })
})
