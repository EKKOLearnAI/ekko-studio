import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationsMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 'conversation-1' }] } })
const getConversationMessagesMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [] } })
const getConversationMessagesPaginatedMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [], pagination: {} } })
const listCategoriesMock = vi.fn(async (ctx: any) => { ctx.body = { categories: [] } })
const createCategoryMock = vi.fn(async (ctx: any) => { ctx.body = { category: { id: 1, name: ctx.request.body.name } } })
const renameCategoryMock = vi.fn(async (ctx: any) => { ctx.body = { category: { id: Number(ctx.params.id), name: ctx.request.body.name } } })
const removeCategoryMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const listMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 's1' }] } })
const countMock = vi.fn(async (ctx: any) => { ctx.body = { count: 1 } })
const listHermesSessionsMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 'hermes-1' }] } })
const listHermesSessionGroupsMock = vi.fn(async (ctx: any) => { ctx.body = { groups: [] } })
const getHermesSessionMock = vi.fn(async (ctx: any) => { ctx.body = { session: { id: ctx.params.id } } })
const importHermesSessionMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id } })
const searchMock = vi.fn(async (ctx: any) => { ctx.body = { results: [{ id: 'search-1' }] } })
const getMock = vi.fn(async (ctx: any) => { ctx.body = { session: { id: ctx.params.id } } })
const getContextMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [] } })
const removeMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const archiveMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const unarchiveMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setPushEnabledMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setWorkspaceMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setCategoryMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setModelMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setReasoningEffortMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const listWorkspaceFoldersMock = vi.fn(async (ctx: any) => { ctx.body = { folders: [] } })
const createWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const deleteWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const usageBatchMock = vi.fn(async (ctx: any) => { ctx.body = {} })
const usageSingleMock = vi.fn(async (ctx: any) => { ctx.body = { input_tokens: 0, output_tokens: 0 } })
const usageStatsMock = vi.fn(async (ctx: any) => { ctx.body = { total_input_tokens: 0, total_output_tokens: 0 } })
const contextLengthMock = vi.fn(async (ctx: any) => { ctx.body = { context_length: 256000 } })
const batchRemoveMock = vi.fn(async (ctx: any) => { ctx.body = { deleted: 1, failed: 0, errors: [] } })
const batchArchiveMock = vi.fn(async (ctx: any) => { ctx.body = { updated: 1, failed: 0, errors: [] } })
const exportSessionMock = vi.fn(async (ctx: any) => { ctx.body = JSON.stringify({ id: ctx.params.id }) })
const listWorkspaceRunChangesMock = vi.fn(async (ctx: any) => { ctx.body = { changes: [] } })
const getWorkspaceRunChangeFileMock = vi.fn(async (ctx: any) => { ctx.body = { file: null } })
const listWorkspaceFilesMock = vi.fn(async (ctx: any) => { ctx.body = { entries: [], path: '' } })
const diffWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { path: ctx.query.path, patch: '' } })
const readWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { content: '' } })
const readWorkspaceFileContentMock = vi.fn(async (ctx: any) => { ctx.body = Buffer.from('content') })
const writeWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const mkdirWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const deleteWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const copyWorkspaceFileMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })

vi.mock('../../packages/server/src/modules/studio/controllers/sessions', () => ({
  listConversations: listConversationsMock,
  getConversationMessages: getConversationMessagesMock,
  getConversationMessagesPaginated: getConversationMessagesPaginatedMock,
  listCategories: listCategoriesMock,
  createCategory: createCategoryMock,
  renameCategory: renameCategoryMock,
  removeCategory: removeCategoryMock,
  list: listMock,
  count: countMock,
  listHermesSessions: listHermesSessionsMock,
  listHermesSessionGroups: listHermesSessionGroupsMock,
  getHermesSession: getHermesSessionMock,
  importHermesSession: importHermesSessionMock,
  search: searchMock,
  get: getMock,
  getContext: getContextMock,
  remove: removeMock,
  batchRemove: batchRemoveMock,
  batchArchive: batchArchiveMock,
  rename: renameMock,
  archive: archiveMock,
  unarchive: unarchiveMock,
  setPushEnabled: setPushEnabledMock,
  setWorkspace: setWorkspaceMock,
  setCategory: setCategoryMock,
  setModel: setModelMock,
  setReasoningEffort: setReasoningEffortMock,
  listWorkspaceFolders: listWorkspaceFoldersMock,
  createWorkspaceFolder: createWorkspaceFolderMock,
  renameWorkspaceFolder: renameWorkspaceFolderMock,
  deleteWorkspaceFolder: deleteWorkspaceFolderMock,
  usageBatch: usageBatchMock,
  usageSingle: usageSingleMock,
  usageStats: usageStatsMock,
  contextLength: contextLengthMock,
  exportSession: exportSessionMock,
  listWorkspaceRunChanges: listWorkspaceRunChangesMock,
  getWorkspaceRunChangeFile: getWorkspaceRunChangeFileMock,
  listWorkspaceFiles: listWorkspaceFilesMock,
  diffWorkspaceFile: diffWorkspaceFileMock,
  readWorkspaceFile: readWorkspaceFileMock,
  readWorkspaceFileContent: readWorkspaceFileContentMock,
  writeWorkspaceFile: writeWorkspaceFileMock,
  mkdirWorkspaceFile: mkdirWorkspaceFileMock,
  deleteWorkspaceFile: deleteWorkspaceFileMock,
  renameWorkspaceFile: renameWorkspaceFileMock,
  copyWorkspaceFile: copyWorkspaceFileMock,
}))

describe('session routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationsMock.mockClear()
    getConversationMessagesMock.mockClear()
    getConversationMessagesPaginatedMock.mockClear()
    listCategoriesMock.mockClear()
    createCategoryMock.mockClear()
    renameCategoryMock.mockClear()
    removeCategoryMock.mockClear()
    listMock.mockClear()
    countMock.mockClear()
    listHermesSessionsMock.mockClear()
    listHermesSessionGroupsMock.mockClear()
    getHermesSessionMock.mockClear()
    importHermesSessionMock.mockClear()
    searchMock.mockClear()
    getMock.mockClear()
    getContextMock.mockClear()
    removeMock.mockClear()
    renameMock.mockClear()
    archiveMock.mockClear()
    batchArchiveMock.mockClear()
    unarchiveMock.mockClear()
    setPushEnabledMock.mockClear()
    setCategoryMock.mockClear()
    setModelMock.mockClear()
    setReasoningEffortMock.mockClear()
    listWorkspaceFoldersMock.mockClear()
    createWorkspaceFolderMock.mockClear()
    renameWorkspaceFolderMock.mockClear()
    deleteWorkspaceFolderMock.mockClear()
    listWorkspaceRunChangesMock.mockClear()
    getWorkspaceRunChangeFileMock.mockClear()
    listWorkspaceFilesMock.mockClear()
    diffWorkspaceFileMock.mockClear()
    readWorkspaceFileMock.mockClear()
    readWorkspaceFileContentMock.mockClear()
    writeWorkspaceFileMock.mockClear()
    mkdirWorkspaceFileMock.mockClear()
    deleteWorkspaceFileMock.mockClear()
    renameWorkspaceFileMock.mockClear()
    copyWorkspaceFileMock.mockClear()
  })

  it('registers conversations, session list, and search routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const paths = sessionRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/studio/sessions/conversations',
      '/api/studio/sessions/conversations/:id/messages',
      '/api/studio/sessions/conversations/:id/messages/paginated',
      '/api/studio/session-categories',
      '/api/studio/session-categories/:id',
      '/api/studio/sessions',
      '/api/studio/sessions/count',
      '/api/studio/sessions/hermes',
      '/api/studio/sessions/hermes/groups',
      '/api/studio/sessions/hermes/:id',
      '/api/studio/sessions/hermes/:id/import',
      '/api/studio/search/sessions',
      '/api/studio/sessions/search',
      '/api/studio/sessions/usage',
      '/api/studio/usage/stats',
      '/api/studio/sessions/context-length',
      '/api/studio/sessions/:id/context',
      '/api/studio/sessions/:id/workspace-run-changes',
      '/api/studio/sessions/:id/workspace-run-changes/:changeId/files/:fileId',
      '/api/studio/sessions/:id/workspace-files/list',
      '/api/studio/sessions/:id/workspace-file/diff',
      '/api/studio/sessions/:id/workspace-file/read',
      '/api/studio/sessions/:id/workspace-file/content',
      '/api/studio/sessions/:id/workspace-file/write',
      '/api/studio/sessions/:id/workspace-file/mkdir',
      '/api/studio/sessions/:id/workspace-file/delete',
      '/api/studio/sessions/:id/workspace-file/rename',
      '/api/studio/sessions/:id/workspace-file/copy',
      '/api/studio/sessions/:id',
      '/api/studio/sessions/:id/export',
      '/api/studio/sessions/:id/usage',
      '/api/studio/sessions/:id/rename',
      '/api/studio/sessions/:id/archive',
      '/api/studio/sessions/:id/unarchive',
      '/api/studio/sessions/:id/push-enabled',
      '/api/studio/sessions/:id/category',
      '/api/studio/sessions/:id/model',
      '/api/studio/sessions/:id/reasoning-effort',
      '/api/studio/workspace/folders',
      '/api/studio/workspace/folders/rename',
    ]))
  })

  it('delegates global category routes and session assignment', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) =>
      entry.path === '/api/studio/session-categories' && entry.methods.includes('HEAD'),
    )
    const createLayer = sessionRoutes.stack.find((entry: any) =>
      entry.path === '/api/studio/session-categories' && entry.methods.includes('POST'),
    )
    const renameLayer = sessionRoutes.stack.find((entry: any) =>
      entry.path === '/api/studio/session-categories/:id' && entry.methods.includes('PATCH'),
    )
    const removeLayer = sessionRoutes.stack.find((entry: any) =>
      entry.path === '/api/studio/session-categories/:id' && entry.methods.includes('DELETE'),
    )
    const assignLayer = sessionRoutes.stack.find((entry: any) =>
      entry.path === '/api/studio/sessions/:id/category',
    )

    const listCtx: any = { query: {}, request: { body: {} }, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listCategoriesMock).toHaveBeenCalledWith(listCtx)

    const createCtx: any = { query: {}, request: { body: { name: 'Work' } }, body: null, params: {} }
    await createLayer.stack[0](createCtx)
    expect(createCategoryMock).toHaveBeenCalledWith(createCtx)

    const renameCtx: any = { query: {}, request: { body: { name: 'Client Work' } }, body: null, params: { id: '1' } }
    await renameLayer.stack[0](renameCtx)
    expect(renameCategoryMock).toHaveBeenCalledWith(renameCtx)

    const removeCtx: any = { query: {}, request: { body: {} }, body: null, params: { id: '1' } }
    await removeLayer.stack[0](removeCtx)
    expect(removeCategoryMock).toHaveBeenCalledWith(removeCtx)

    const assignCtx: any = { query: {}, request: { body: { categoryId: 1 } }, body: null, params: { id: 'session-1' } }
    await assignLayer.stack[0](assignCtx)
    expect(setCategoryMock).toHaveBeenCalledWith(assignCtx)
  })

  it('delegates session count route before the session id route', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const countLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/count')
    const idLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id')
    expect(sessionRoutes.stack.indexOf(countLayer)).toBeLessThan(sessionRoutes.stack.indexOf(idLayer))

    const ctx: any = { query: { source: 'cli' }, body: null, params: {} }
    await countLayer.stack[0](ctx)

    expect(countMock).toHaveBeenCalledWith(ctx)
    expect(getMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ count: 1 })
  })

  it('registers Hermes history groups before the Hermes session id route', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const groupsLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/hermes/groups')
    const idLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/hermes/:id')

    expect(sessionRoutes.stack.indexOf(groupsLayer)).toBeLessThan(sessionRoutes.stack.indexOf(idLayer))

    const ctx: any = { query: { limit: '20' }, body: null, params: {} }
    await groupsLayer.stack[0](ctx)

    expect(listHermesSessionGroupsMock).toHaveBeenCalledWith(ctx)
    expect(getHermesSessionMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ groups: [] })
  })

  it('delegates session context route to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/context')
    const handler = layer.stack[0]
    const ctx: any = { query: {}, body: null, params: { id: 'session-1' } }

    await handler(ctx)

    expect(getContextMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ session_id: 'session-1', messages: [] })
  })

  it('delegates workspace folder routes to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/workspace/folders' && entry.methods.includes('HEAD'))
    const createLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/workspace/folders' && entry.methods.includes('POST'))
    const renameLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/workspace/folders/rename')
    const deleteLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/workspace/folders' && entry.methods.includes('DELETE'))

    const listCtx: any = { query: {}, request: { body: {} }, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listWorkspaceFoldersMock).toHaveBeenCalledWith(listCtx)

    const createCtx: any = { query: {}, request: { body: { parentPath: '', name: 'new-folder' } }, body: null, params: {} }
    await createLayer.stack[0](createCtx)
    expect(createWorkspaceFolderMock).toHaveBeenCalledWith(createCtx)

    const renameCtx: any = { query: {}, request: { body: { path: 'old-folder', name: 'new-folder' } }, body: null, params: {} }
    await renameLayer.stack[0](renameCtx)
    expect(renameWorkspaceFolderMock).toHaveBeenCalledWith(renameCtx)

    const deleteCtx: any = { query: {}, request: { body: { path: 'new-folder' } }, body: null, params: {} }
    await deleteLayer.stack[0](deleteCtx)
    expect(deleteWorkspaceFolderMock).toHaveBeenCalledWith(deleteCtx)
  })

  it('delegates session workspace file routes to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-files/list')
    const diffLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/diff')
    const readLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/read')
    const contentLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/content')
    const writeLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/write')
    const mkdirLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/mkdir')
    const deleteLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/delete')
    const renameLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/rename')
    const copyLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/workspace-file/copy')

    const ctx: any = { query: {}, request: { body: {} }, body: null, params: { id: 'session-1' } }
    await listLayer.stack[0](ctx)
    await diffLayer.stack[0](ctx)
    await readLayer.stack[0](ctx)
    await contentLayer.stack[0](ctx)
    await writeLayer.stack[0](ctx)
    await mkdirLayer.stack[0](ctx)
    await deleteLayer.stack[0](ctx)
    await renameLayer.stack[0](ctx)
    await copyLayer.stack[0](ctx)

    expect(listWorkspaceFilesMock).toHaveBeenCalledWith(ctx)
    expect(diffWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(readWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(readWorkspaceFileContentMock).toHaveBeenCalledWith(ctx)
    expect(writeWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(mkdirWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(deleteWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(renameWorkspaceFileMock).toHaveBeenCalledWith(ctx)
    expect(copyWorkspaceFileMock).toHaveBeenCalledWith(ctx)
  })

  it('delegates session search to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/search/sessions')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker', limit: '8' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('keeps the legacy search path wired to the same controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/search')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('delegates conversations list and detail routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/conversations')
    const detailLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/conversations/:id/messages')

    const listCtx: any = { query: {}, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listConversationsMock).toHaveBeenCalledWith(listCtx)
    expect(listCtx.body).toEqual({ sessions: [{ id: 'conversation-1' }] })

    const detailCtx: any = { params: { id: 'child-session' }, query: {}, body: null }
    await detailLayer.stack[0](detailCtx)
    expect(getConversationMessagesMock).toHaveBeenCalledWith(detailCtx)
    expect(detailCtx.body).toEqual({ session_id: 'child-session', messages: [] })
  })

  it('delegates Hermes session import to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/hermes/:id/import')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'hermes-abc' }, query: {}, request: { body: { profile: 'default' } }, body: null }

    await handler(ctx)

    expect(importHermesSessionMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ session_id: 'hermes-abc' })
  })

  it('delegates session export to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/export')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'session-abc' }, query: {}, body: null, set: vi.fn() }

    await handler(ctx)

    expect(exportSessionMock).toHaveBeenCalledWith(ctx)
  })

  it('delegates session archive to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/archive')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'session-abc' }, query: {}, body: null }

    await handler(ctx)

    expect(archiveMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ ok: true })
  })

  it('delegates batch session archive updates to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/batch-archive')
    const handler = layer.stack[0]
    const ctx: any = { request: { body: { ids: ['session-abc'], archived: true } }, state: {}, body: null }

    await handler(ctx)

    expect(batchArchiveMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ updated: 1, failed: 0, errors: [] })
  })

  it('delegates session unarchive to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/modules/studio/routes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/studio/sessions/:id/unarchive')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'session-abc' }, query: {}, body: null }

    await handler(ctx)

    expect(unarchiveMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ ok: true })
  })
})
