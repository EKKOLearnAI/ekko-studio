import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('message deletion and compression history', () => {
  let db: any
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function fixture() {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const deletion = await import('../../packages/server/src/modules/studio/repositories/session-message-deletion')
    const compression = await import('../../packages/server/src/modules/studio/repositories/compression-snapshot')
    store.createSession({ id: 's', source: 'cli' })
    const add = (role: string, content: string, run_marker?: string, extra = {}) => store.addMessage({ session_id: 's', role, content, run_marker, ...extra })!
    return { ...store, ...deletion, ...compression, add }
  }

  it.each([
    ['cli', 'hermes'], ['builtin_agent', 'ekko-agent'], ['coding_agent', 'codex'], ['coding_agent', 'cursor'],
    ['group_chat', 'hermes'], ['group_chat', 'ekko-agent'], ['group_chat', 'codex'],
    ['workflow', 'hermes'], ['workflow', 'ekko-agent'], ['workflow', 'codex'], ['global_agent', 'ekko-agent'],
  ].flatMap(([source, agent]) => [6, 180].map(count => ({ source, agent, count }))))(
    'restores ordinary $source/$agent sessions with $count rows using real storage and keeps live state intact',
    async ({ source, agent, count }) => {
      const f = await fixture()
      db.prepare('UPDATE sessions SET source = ?, agent = ? WHERE id = ?').run(source, agent, 's')
      const ids = Array.from({ length: count }, (_, index) => f.add(index % 2 ? 'assistant' : 'user', `ordinary ${index}`, `r-${Math.floor(index / 2)}`))
      const { updateUsage, getRecordedUsageTotals } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
      const usageSource = agent === 'ekko-agent' ? 'ekko_agent' : agent === 'hermes' ? 'hermes' : 'coding_agent'
      updateUsage('s', { source: usageSource, inputTokens: 1234, outputTokens: 66, createdAt: Date.now() })
      const before = f.getSessionDetail('s')
      const billing = getRecordedUsageTotals('s', usageSource)
      const { getOrCreateSession } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
      const { readSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
      const { buildResumeMessagePage } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
      const sessions = new Map<string, any>()
      const state = getOrCreateSession(sessions, 's')
      expect(state).toEqual(readSessionStateFromDb('s'))
      expect(state.messages.map(m => m.id)).toEqual(ids.slice(-150))
      expect(buildResumeMessagePage(state.messages, state)).toMatchObject({ messageTotal: count, hasMoreBefore: count > 150 })
      expect(state).toMatchObject({ inputTokens: 1234, outputTokens: 66 })
      state.isWorking = true
      state.runId = 'active-run'
      state.queue.push({ queue_id: 'queued-input', input: 'next' } as any)
      state.events.push({ event: 'message.delta', data: { delta: 'streaming' } })
      const controller = state.abortController = new AbortController()
      expect(getOrCreateSession(sessions, 's')).toBe(state)
      expect(state.isWorking).toBe(true)
      expect(state.runId).toBe('active-run')
      expect(state.abortController).toBe(controller)
      expect(state.queue).toHaveLength(1)
      expect(state.events).toHaveLength(1)
      expect(f.getSessionDetail('s')).toEqual(before)
      expect(getRecordedUsageTotals('s', usageSource)).toEqual(billing)
      expect(f.getCompressionSnapshot('s')).toBeNull()
    },
  )

  it.each([
    ['hermes', 6], ['ekko-agent', 6], ['hermes', 180], ['ekko-agent', 180],
  ])('retains %s history (%i rows) after deletion, another run and warm/cold resume', async (agent, oldCount) => {
    const f = await fixture()
    db.prepare('UPDATE sessions SET agent = ? WHERE id = ?').run(agent, 's')
    const { getOrCreateSession, buildDbSnapshotAwareHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { buildResumeMessagePage } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
    const { handleMessage } = await import('../../packages/server/src/modules/studio/services/chat-run/message-format')
    const retained = Array.from({ length: Number(oldCount) }, (_, i) =>
      f.add(i % 2 ? 'assistant' : 'user', `retained message ${i}`, `old-${Math.floor(i / 2)}`))
    const removeUser = f.add('user', 'delete this input')
    const removeAnswer = f.add('assistant', 'delete this answer', 'deleted-run')
    f.saveCompressionSnapshot('s', 'retained context summary', 0, 0, {
      compressedThroughMessageId: retained[1], protectedHeadThroughMessageId: retained[0], expectedHistoryRevision: 0,
    })
    const snapshot = f.getCompressionSnapshot('s')!
    const sessions = new Map<string, any>()
    sessions.set('s', await loadSessionStateFromDb('s', sessions))
    f.deleteSessionMessageGroups('s', [removeUser, removeAnswer], 0)
    sessions.delete('s') // The controller invalidates the display cache after an edit.

    // Run dispatch reserves state before the agent handler is reached.
    const state = getOrCreateSession(sessions, 's')
    expect(state.messages.map(m => Number(m.id))).toEqual(retained.slice(-150))
    expect(state.messageTotal).toBe(oldCount)
    expect(state.messageStateBaselineCount).toBe(Math.min(Number(oldCount), 150))
    for (let turn = 0; turn < 2; turn++) {
      state.isWorking = true
      const input = f.add('user', `new input ${turn}`)
      const answer = f.add('assistant', `new answer ${turn}`, `next-run-${turn}`)
      const appended = f.getSessionDetailPaginated('s')!.messages.filter(m => m.id === input || m.id === answer)
      state.messages.push(...handleMessage(appended, 's'))
      // Resuming while running must retain the original state and pending events.
      state.events.push({ event: 'test.live', data: { turn } })
      expect(getOrCreateSession(sessions, 's')).toBe(state)
      expect(state.isWorking).toBe(true)
      state.isWorking = false
      const page = buildResumeMessagePage(state.messages, state)
      const dbPage = f.getSessionDetailPaginated('s')!
      expect(page.messages.map(m => Number(m.id))).toEqual(dbPage.messages.map(m => m.id))
      expect(page.messageTotal).toBe(Number(oldCount) + (turn + 1) * 2)
      expect(page.messageLoadedCount).toBe(Math.min(page.messageTotal, 150))
      expect(page.hasMoreBefore).toBe(Number(oldCount) > 150)
      expect(f.getCompressionSnapshot('s')).toEqual({ ...snapshot, historyRevision: 1 })
    }
    const effectiveContext = await buildDbSnapshotAwareHistory('s', 'default')
    expect(effectiveContext.some(m => String(m.content).includes('retained context summary'))).toBe(true)
    expect(effectiveContext.some(m => String(m.content).includes('delete this'))).toBe(false)
    const warmPage = buildResumeMessagePage(state.messages, state)
    sessions.clear()
    const coldState = await loadSessionStateFromDb('s', sessions)
    expect(buildResumeMessagePage(coldState.messages, coldState)).toEqual(warmPage)
    expect(f.getSessionContextMessages('s').map(m => m.id)).toEqual(expect.arrayContaining(retained))
  })

  it.each(['hermes', 'ekko-agent'])('deletes only the selected identical input for %s and does not restore it on resume', async agent => {
    const f = await fixture()
    db.prepare('UPDATE sessions SET agent = ?, source = ? WHERE id = ?')
      .run(agent, agent === 'hermes' ? 'cli' : 'builtin_agent', 's')
    const { getOrCreateSession, buildDbSnapshotAwareHistory } = await import('../../packages/server/src/modules/studio/services/chat-run/compression')
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { buildResumeMessagePage } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
    const oldInput = f.add('user', '继续', undefined, { timestamp: 1_792_141_866 })
    const oldAnswer = f.add('assistant', 'old answer', 'old-run')
    const recentInput = f.add('user', '继续')
    const recentAnswer = f.add('assistant', 'recent answer', 'recent-run')
    const sessions = new Map<string, any>()
    expect(f.getMessageSelectionGroups('s').filter(group => group.kind === 'message').map(group => group.id))
      .toEqual([oldInput, recentInput])
    expect(f.deleteSessionMessageGroups('s', [recentInput, recentAnswer], 0).messageIds)
      .toEqual([recentInput, recentAnswer])
    const retained = getOrCreateSession(sessions, 's')
    expect(buildResumeMessagePage(retained.messages, retained).messages.map(m => m.id)).toEqual([oldInput, oldAnswer])
    expect(retained.messages[0]).toMatchObject({ content: '继续', timestamp: 1_792_141_866 })

    // Deleting the earlier identical input must also survive another run and
    // a cold resume. Neither text matching nor a stale cache can restore it.
    expect(f.deleteSessionMessageGroups('s', [oldInput], 1).messageIds).toEqual([oldInput])
    sessions.delete('s')
    expect(getOrCreateSession(sessions, 's').messages.map(m => m.id)).toEqual([oldAnswer])
    const nextInput = f.add('user', 'next question')
    const nextAnswer = f.add('assistant', 'next answer', 'next-run')
    sessions.clear()
    const cold = await loadSessionStateFromDb('s', sessions)
    expect(buildResumeMessagePage(cold.messages, cold).messages.map(m => m.id)).toEqual([oldAnswer, nextInput, nextAnswer])
    expect((await buildDbSnapshotAwareHistory('s', 'default')).some(m => m.content === '继续')).toBe(false)
    expect(f.getSessionDetailPaginated('s')?.messages.map(m => m.id)).toEqual([oldAnswer, nextInput, nextAnswer])
    expect(f.getCompressionSnapshot('s')).toBeNull()
  })

  it.each(['hermes', 'ekko-agent'])('keeps %s compressed context, overhead and billing stable through deletion and cold reload', async agent => {
    const f = await fixture()
    db.prepare('UPDATE sessions SET agent = ? WHERE id = ?').run(agent, 's')
    const { getSessionContextOverhead, estimateSessionContextTokens, refreshContextUsageAfterDeletion } = await import('../../packages/server/src/modules/studio/services/chat-run/context-usage')
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { getSessionContextUsageEstimate } = await import('../../packages/server/src/modules/studio/repositories/session-context-usage')
    const { updateUsage, getRecordedUsageTotals } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    const head = f.add('user', 'original question')
    const cursor = f.add('assistant', 'large compressed history '.repeat(10_000), 'run-1')
    const tail = f.add('user', 'delete this question '.repeat(100))
    const kept = f.add('assistant', 'keep this answer', 'run-2')
    f.saveCompressionSnapshot('s', 'small unchanged summary', 0, 0, {
      compressedThroughMessageId: cursor, protectedHeadThroughMessageId: head, expectedHistoryRevision: 0,
    })
    const snapshot = f.getCompressionSnapshot('s')!
    const source = agent === 'hermes' ? 'hermes' : 'ekko_agent'
    updateUsage('s', { source, inputTokens: 100_000, outputTokens: 36_100, createdAt: 1000 })
    const billing = getRecordedUsageTotals('s', source)
    const state = { [agent === 'hermes' ? 'bridgeContext' : 'ekkoContext']: { fixedContextTokens: 12_000 } } as any
    const overhead = getSessionContextOverhead('s', state)
    const before = estimateSessionContextTokens('s', overhead)!
    f.deleteSessionMessageGroups('s', [tail], 0)
    const after = refreshContextUsageAfterDeletion('s', overhead)!
    expect(after).toBeGreaterThan(12_000)
    expect(after).toBeLessThan(before)
    expect(after).toBeLessThan(19_000)
    expect(f.getCompressionSnapshot('s')).toEqual({ ...snapshot, historyRevision: 1 })
    expect(getSessionContextUsageEstimate('s')).toEqual({ tokens: after, fixedTokens: 12_000 })
    expect(await loadSessionStateFromDb('s', new Map())).toMatchObject({ contextTokens: after, inputTokens: 100_000, outputTokens: 36_100 })
    expect(getRecordedUsageTotals('s', source)).toEqual(billing)
    // Another deletion after the transcript cache was evicted keeps the overhead.
    const restoredOverhead = getSessionContextOverhead('s')
    expect(restoredOverhead).toBe(12_000)
    f.deleteSessionMessageGroups('s', [kept], 1)
    const second = refreshContextUsageAfterDeletion('s', restoredOverhead)!
    expect(second).toBeGreaterThan(12_000)
    expect(second).toBeLessThan(after)
    expect((await loadSessionStateFromDb('s', new Map())).contextTokens).toBe(second)
    expect(f.getCompressionSnapshot('s')).toEqual({ ...snapshot, historyRevision: 2 })
    // A later run or new summary must not reuse an estimate of the edited history.
    const next = f.add('user', 'new run')
    expect(getSessionContextUsageEstimate('s')).toBeUndefined()
    refreshContextUsageAfterDeletion('s', restoredOverhead)
    f.saveCompressionSnapshot('s', 'next summary', 0, 0, {
      compressedThroughMessageId: next, protectedHeadThroughMessageId: head, expectedHistoryRevision: 2,
    })
    db.prepare('UPDATE chat_compression_snapshots SET updated_at = ? WHERE session_id = ?').run(snapshot.updatedAt, 's')
    expect(getSessionContextUsageEstimate('s')).toBeUndefined()
  })

  it('restores zero context after deleting all uncompressed messages despite historical usage', async () => {
    const f = await fixture()
    const id = f.add('user', 'delete everything')
    const { refreshContextUsageAfterDeletion } = await import('../../packages/server/src/modules/studio/services/chat-run/context-usage')
    const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
    const { updateUsage } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    updateUsage('s', { source: 'hermes', inputTokens: 100_000, outputTokens: 36_100, createdAt: 1000 })
    f.deleteSessionMessageGroups('s', [id], 0)
    expect(refreshContextUsageAfterDeletion('s', 0)).toBe(0)
    expect(await loadSessionStateFromDb('s', new Map())).toMatchObject({ contextTokens: 0, inputTokens: 100_000, outputTokens: 36_100 })
  })

  it.each(['legacy', 'invalid'])('does not expand history or mutate a %s summary while estimating usage', async mode => {
    const f = await fixture()
    const id = f.add('user', 'large history '.repeat(10_000))
    f.saveCompressionSnapshot('s', 'keep this summary', 0, 1, mode === 'legacy' ? undefined
      : { compressedThroughMessageId: id, expectedHistoryRevision: 0 })
    if (mode === 'invalid') db.exec('UPDATE chat_compression_snapshots SET history_revision = 99')
    const snapshot = f.getCompressionSnapshot('s')
    const { estimateSessionContextTokens } = await import('../../packages/server/src/modules/studio/services/chat-run/context-usage')
    expect(estimateSessionContextTokens('s')).toBeUndefined()
    expect(f.getCompressionSnapshot('s')).toEqual(snapshot)
  })

  it('expands a single selected answer into the complete run across pages, including tools and reasoning', async () => {
    const f = await fixture()
    const user = f.add('user', 'question', 'run-1')
    const call = f.add('assistant', '', 'run-1', { reasoning: 'private reasoning', tool_calls: [{ id: 'tc', type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
    const tool = f.add('tool', 'tool payload', 'run-1', { tool_call_id: 'tc' })
    const answer = f.add('assistant', 'answer', 'run-1')
    const next = f.add('user', 'keep this')
    const nextAnswer = f.add('assistant', 'keep answer', 'run-2')
    expect(f.getSessionDetailPaginated('s', 0, 3)?.messages.map(m => m.id)).toEqual([answer, next, nextAnswer])
    expect(f.getMessageSelectionGroups('s')).toEqual([
      { id: user, kind: 'message', messageIds: [user] },
      { id: call, kind: 'run', messageIds: [call, tool, answer], runMarker: 'run-1' },
      { id: next, kind: 'message', messageIds: [next] },
      { id: nextAnswer, kind: 'run', messageIds: [nextAnswer], runMarker: 'run-2' },
    ])
    db.prepare('INSERT INTO task_plans VALUES (?, ?, ?, ?, ?, ?, ?)').run('s', 'p', 'run-1', 1, 'ended', '{}', 1)
    db.prepare('INSERT INTO workspace_run_changes (change_id, session_id, assistant_message_id, created_at) VALUES (?, ?, ?, ?)').run('change', 's', String(answer), 1)
    db.prepare('INSERT INTO workspace_run_change_files (change_id, session_id, path, created_at) VALUES (?, ?, ?, ?)').run('change', 's', 'a.txt', 1)
    const result = f.deleteSessionMessageGroups('s', [answer, call], 0)
    expect(result).toMatchObject({ deleted: 3, deletedGroups: 1, messageIds: [call, tool, answer], historyRevision: 1 })
    expect(f.getSessionContextMessages('s').map(m => m.id)).toEqual([user, next, nextAnswer])
    expect(f.getSession('s')).toMatchObject({ message_count: 3, tool_call_count: 0, history_revision: 1 })
    for (const table of ['task_plans', 'workspace_run_changes', 'workspace_run_change_files']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count).toBe(0)
    }
  })

  it('locks the compressed prefix and whole runs crossing the cursor, including protected head messages', async () => {
    const f = await fixture()
    const head = f.add('user', 'protected original input')
    const call = f.add('assistant', '', 'run-1', { tool_calls: [{ id: 'tc', type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
    const cursor = f.add('tool', 'compressed result', 'run-1', { tool_call_id: 'tc' })
    const answer = f.add('assistant', 'answer after the cursor', 'run-1')
    const tail = f.add('user', 'uncompressed input')
    f.saveCompressionSnapshot('s', 'keep summary', 0, 0, {
      compressedThroughMessageId: cursor, protectedHeadThroughMessageId: head, expectedHistoryRevision: 0,
    })
    const before = f.getCompressionSnapshot('s')
    expect(f.getMessageSelectionGroups('s')).toEqual([
      { id: head, kind: 'message', messageIds: [head], deleteBlockedReason: 'compressed' },
      { id: call, kind: 'run', messageIds: [call, cursor, answer], runMarker: 'run-1', deleteBlockedReason: 'compressed' },
      { id: tail, kind: 'message', messageIds: [tail] },
    ])
    for (const selected of [[head], [answer], [tail, answer]]) {
      expect(() => f.deleteSessionMessageGroups('s', selected, 0)).toThrow('Compressed messages cannot be deleted')
    }
    expect(f.getSessionContextMessages('s')).toHaveLength(5)
    expect(f.getSession('s')?.history_revision).toBe(0)
    expect(f.getCompressionSnapshot('s')).toEqual(before)
  })

  it('deletes only the tail while preserving summary, cursor, ordinals and timestamp, and rejects stale summaries', async () => {
    const f = await fixture()
    const head = f.add('user', 'original question')
    const cursor = f.add('assistant', 'compressed answer', 'run-1')
    const tail = f.add('user', 'remove tail')
    const answer = f.add('assistant', 'remove tail answer', 'run-2')
    f.saveCompressionSnapshot('s', 'unchanged summary', 0, 0, {
      compressedThroughMessageId: cursor, protectedHeadThroughMessageId: head, expectedHistoryRevision: 0,
    })
    const before = f.getCompressionSnapshot('s')!
    f.deleteSessionMessageGroups('s', [tail, answer], 0)
    expect(f.getCompressionSnapshot('s')).toEqual({ ...before, historyRevision: 1 })
    expect(f.getSession('s')).toMatchObject({ history_revision: 1, message_count: 2 })
    expect(f.getSessionContextMessages('s').map(m => m.id)).toEqual([head, cursor])
    expect(f.getSessionContextMessages('s', { afterId: cursor })).toEqual([])
    expect(f.saveCompressionSnapshot('s', 'stale cursor summary', 1, 2, {
      compressedThroughMessageId: cursor, expectedHistoryRevision: 0,
    })).toBe(false)
    expect(f.saveCompressionSnapshot('s', 'stale legacy summary', 0, 2, undefined, 0)).toBe(false)
    expect(f.getCompressionSnapshot('s')).toEqual({ ...before, historyRevision: 1 })
    // Future ordinary compression can still advance this snapshot.
    const newer = f.add('user', 'new uncompressed input')
    expect(f.saveCompressionSnapshot('s', 'next summary', 0, 0, {
      compressedThroughMessageId: newer, protectedHeadThroughMessageId: head, expectedHistoryRevision: 1,
    })).toBe(true)
  })

  it('rechecks a cursor that advanced after selection without changing the history revision', async () => {
    const f = await fixture()
    const head = f.add('user', 'first')
    const tail = f.add('assistant', 'initially selectable', 'r1')
    f.saveCompressionSnapshot('s', 'initial summary', 0, 0, { compressedThroughMessageId: head, expectedHistoryRevision: 0 })
    expect(f.getMessageSelectionGroups('s')[1].deleteBlockedReason).toBeUndefined()
    f.saveCompressionSnapshot('s', 'advanced summary', 0, 0, { compressedThroughMessageId: tail, expectedHistoryRevision: 0 })
    expect(() => f.deleteSessionMessageGroups('s', [tail], 0)).toThrow('Compressed messages cannot be deleted')
    expect(f.getCompressionSnapshot('s')?.summary).toBe('advanced summary')
  })

  it.each(['legacy', 'missing cursor', 'stale revision', 'invalid protected head'])('does not guess a deletable range for a %s snapshot', async mode => {
    const f = await fixture()
    const head = f.add('user', 'first')
    const tail = f.add('assistant', 'tail', 'r1')
    f.saveCompressionSnapshot('s', 'keep summary', 0, 2, mode === 'legacy' ? undefined
      : { compressedThroughMessageId: head, expectedHistoryRevision: 0 })
    if (mode === 'missing cursor') db.exec('UPDATE chat_compression_snapshots SET compressed_through_message_id = 999')
    if (mode === 'stale revision') db.exec('UPDATE chat_compression_snapshots SET history_revision = 99')
    if (mode === 'invalid protected head') db.prepare('UPDATE chat_compression_snapshots SET protected_head_through_message_id = ?').run(tail)
    const before = f.getCompressionSnapshot('s')
    expect(f.getMessageSelectionGroups('s').every(g => g.deleteBlockedReason === 'compression_boundary_unknown')).toBe(true)
    expect(() => f.deleteSessionMessageGroups('s', [tail], 0)).toThrow('Compressed messages cannot be deleted')
    expect(f.getCompressionSnapshot('s')).toEqual(before)
    expect(f.getSession('s')?.history_revision).toBe(0)
  })

  it('preserves legacy run boundaries when the separating user message is deleted', async () => {
    const f = await fixture()
    const first = f.add('assistant', 'first')
    const separator = f.add('user', 'separator')
    const second = f.add('assistant', 'second')
    const tool = f.add('tool', 'second tool')
    f.deleteSessionMessageGroups('s', [separator], 0)
    expect(f.getMessageSelectionGroups('s').map(g => g.messageIds)).toEqual([[first], [second, tool]])
    f.deleteSessionMessageGroups('s', [second], 1)
    expect(f.getSessionContextMessages('s').map(m => m.id)).toEqual([first])
  })

  it('rejects cross-session IDs and outdated selections atomically', async () => {
    const f = await fixture()
    const id = f.add('user', 'keep')
    f.createSession({ id: 'other', source: 'builtin_agent' })
    const other = f.addMessage({ session_id: 'other', role: 'user', content: 'other' })!
    f.saveCompressionSnapshot('s', 'keep summary', 0, 1)
    expect(() => f.deleteSessionMessageGroups('s', [id, other], 0)).toThrow('no longer exist')
    expect(() => f.deleteSessionMessageGroups('s', [id], 3)).toThrow('history changed')
    expect(f.getSessionContextMessages('s')).toHaveLength(1)
    expect(f.getSessionContextMessages('other')).toHaveLength(1)
    expect(f.getCompressionSnapshot('s')?.summary).toBe('keep summary')
    expect(f.getSession('s')?.history_revision).toBe(0)
  })

  it('keeps partially marked legacy tool interactions with their final answer after deleting an input boundary', async () => {
    const f = await fixture()
    const earlier = f.add('assistant', 'earlier', 'r1')
    const user = f.add('user', 'next')
    const call = f.add('assistant', '')
    const tool = f.add('tool', 'result')
    const answer = f.add('assistant', 'answer', 'r2')
    expect(f.getMessageSelectionGroups('s').map(group => group.messageIds)).toEqual([[earlier], [user], [call, tool, answer]])
    f.deleteSessionMessageGroups('s', [user], 0)
    expect(f.getMessageSelectionGroups('s').map(group => group.messageIds)).toEqual([[earlier], [call, tool, answer]])
  })

  it('rolls back message and marker changes if updating the session fails', async () => {
    const f = await fixture()
    const id = f.add('user', 'keep')
    f.add('assistant', 'legacy answer')
    db.exec("CREATE TRIGGER fail_delete_revision BEFORE UPDATE OF history_revision ON sessions BEGIN SELECT RAISE(ABORT, 'failed revision'); END")
    expect(() => f.deleteSessionMessageGroups('s', [id], 0)).toThrow()
    expect(f.getSessionContextMessages('s')).toHaveLength(2)
    expect(f.getSessionContextMessages('s')[1].run_marker).toBeNull()
    expect(f.getSession('s')?.history_revision).toBe(0)
  })

  it('deletes all history without changing accumulated billing', async () => {
    const f = await fixture()
    const a = f.add('user', 'first')
    const b = f.add('assistant', 'answer', 'run-1')
    f.updateSession('s', { input_tokens: 42, output_tokens: 7, estimated_cost_usd: 0.1 })
    f.deleteSessionMessageGroups('s', [a, b], 0)
    expect(f.getSession('s')).toMatchObject({ message_count: 0, preview: '', input_tokens: 42, output_tokens: 7, estimated_cost_usd: 0.1 })
    expect(f.getMessageSelectionGroups('s')).toEqual([])
  })
})
