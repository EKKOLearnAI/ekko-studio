import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DiscussionRunner,
  type DiscussionRow,
  type DiscussionState,
  type DiscussionStorage,
} from '../../packages/server/src/modules/studio/services/group-chat/discussion'

vi.mock('../../packages/server/src/modules/studio/services/group-chat/bare-model', () => ({ runBareModelAgent: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/document-store', () => ({ listDocumentsByRoom: vi.fn(() => []) }))
import { listDocumentsByRoom } from '../../packages/server/src/modules/studio/repositories/document-store'
import { runBareModelAgent } from '../../packages/server/src/modules/studio/services/group-chat/bare-model'
const listDocumentsByRoomMock = vi.mocked(listDocumentsByRoom)

const judgeMock = vi.mocked(runBareModelAgent)
const ACTIVE_STATUSES = new Set(['pending', 'running', 'paused'])

beforeEach(() => {
  listDocumentsByRoomMock.mockReset()
  listDocumentsByRoomMock.mockReturnValue([])
})

interface AgentSpec {
  agentId: string
  name: string
  profile: string
  reply?: (content: string) => Promise<void>
}

const DEFAULT_AGENTS: AgentSpec[] = [
  { agentId: 'agent-a', name: 'Agent A', profile: 'p-a' },
  { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
]

function judgeJson(overrides: { converged?: boolean; stalled?: boolean; progress?: boolean } = {}): string {
  return JSON.stringify({
    converged: false,
    stalled: false,
    progress: false,
    assessment: '双方观点已清晰',
    suggestion: '继续深入讨论',
    ...overrides,
  })
}

function harness(opts: {
  agents?: AgentSpec[]
  messageCount?: number
  substantiveMessageCount?: number
  /** Bump the substantive counter by this amount per agent speech, simulating
   *  messages accumulating during the run (used by mid-run archive tests). */
  growSubstantivePerSpeech?: number
  interruptRoom?: () => Promise<void>
} = {}) {
  const rows = new Map<string, DiscussionRow>()
  const contextMessages: Array<Record<string, unknown>> = []
  let messageCount = opts.messageCount ?? 0
  let substantiveCount = opts.substantiveMessageCount ?? opts.messageCount ?? 0
  const room = {
    summaryProfile: 'default',
    summaryProvider: 'openai',
    summaryModel: 'gpt-test',
    summaryApiMode: 'chat_completions',
  }
  const agentSpecs = opts.agents ?? DEFAULT_AGENTS
  const agents = agentSpecs.map(spec => ({ id: spec.agentId, agentId: spec.agentId, profile: spec.profile, name: spec.name }))
  const speechLog: Array<{ agentId: string; content: string }> = []
  const clients = agentSpecs.map(spec => ({
    agentId: spec.agentId,
    name: spec.name,
    profile: spec.profile,
    replyToMention: vi.fn(async (_roomId: string, msg: { content: unknown }, _rt: unknown, onStatus?: (status: 'compressing' | 'replying' | 'ready') => void) => {
      onStatus?.('replying')
      speechLog.push({ agentId: spec.agentId, content: String(msg.content) })
      if (opts.growSubstantivePerSpeech) substantiveCount += opts.growSubstantivePerSpeech
      await spec.reply?.(String(msg.content))
    }),
  }))

  const storage: DiscussionStorage = {
    getRoom: (roomId: string) => (roomId === 'room-1' ? room : undefined),
    getRoomAgents: () => agents,
    getMessageCount: () => messageCount,
    getSubstantiveMessageCount: () => substantiveCount,
    getMessagesForContext: () => contextMessages,
    getDiscussionByRoom: (roomId: string) => rows.get(roomId) || null,
    listDiscussions: () => [...rows.values()],
    saveDiscussion: (row: DiscussionRow) => {
      rows.set(row.roomId, { ...row })
    },
    updateDiscussion: (roomId: string, fields: Partial<DiscussionRow>) => {
      const current = rows.get(roomId)
      if (current) rows.set(roomId, { ...current, ...fields })
    },
    markDiscussionsFailed: (statuses: string[]) => {
      for (const row of rows.values()) {
        if (statuses.includes(row.status)) {
          row.status = 'failed'
          row.lastError = 'Discussion run was interrupted'
        }
      }
    },
  }

  const broadcasts: DiscussionState[] = []
  const systemMessages: Array<{ roomId: string; content: string }> = []
  const archiveCalls: string[] = []
  const agentStatusLog: Array<{ roomId: string; agentName: string; status: string }> = []
  const interruptRoom = opts.interruptRoom || vi.fn(async () => {})
  const runner = new DiscussionRunner({
    storage,
    agentClients: {
      getAgents: () => clients as any,
      interruptRoom,
    },
    roomSummaryService: {
      prepareForMessage: async () => ({ summary: '', history: [] }),
      // Must be called as a method (this bound); a detached call would break the
      // real service which relies on this.withRoomLock/this.storage.
      archiveRoom: async function (this: unknown, roomId: string) {
        if (this == null) throw new Error('archiveRoom lost its this binding')
        archiveCalls.push(roomId)
        return {
          archived: true,
          deletedMessages: 0,
          summary: {
            roomId,
            summary: 'archived',
            summaryThroughMessageId: '',
            summaryThroughMessageTimestamp: 0,
            summarizedTurnCount: 0,
            status: 'success',
            version: 1,
            updatedAt: 0,
            lastError: null,
          },
        }
      },
    },
    emitSystemMessage: async (roomId: string, content: string) => {
      systemMessages.push({ roomId, content })
    },
    broadcast: (roomId: string, state: DiscussionState) => {
      broadcasts.push({ ...state })
    },
    onAgentStatus: (roomId: string, agentName: string, status: 'compressing' | 'replying' | 'ready') => {
      agentStatusLog.push({ roomId, agentName, status })
    },
  })

  function speechCalls(): Array<{ agentId: string; content: string }> {
    return speechLog
  }

  return {
    runner,
    storage,
    rows,
    clients,
    broadcasts,
    systemMessages,
    contextMessages,
    speechCalls,
    archiveCalls,
    agentStatusLog,
    setMessageCount: (value: number) => {
      messageCount = value
      substantiveCount = value
    },
    setSubstantiveMessageCount: (value: number) => {
      substantiveCount = value
    },
  }
}

async function waitForDone(runner: DiscussionRunner, roomId: string): Promise<DiscussionState> {
  return await vi.waitFor(() => {
    const current = runner.getState(roomId)
    if (current && !ACTIVE_STATUSES.has(current.status)) return current
    throw new Error(`discussion still active (${current?.status})`)
  })
}

describe('group chat free discussion runner', () => {
  beforeEach(() => {
    judgeMock.mockReset()
    judgeMock.mockResolvedValue(judgeJson())
  })

  it('rejects invalid starts: missing room, empty goal, fewer than 2 agents, duplicate 409', async () => {
    const { runner } = harness()

    await expect(runner.start('missing-room', { goal: 'go' })).rejects.toMatchObject({ status: 404 })
    await expect(runner.start('room-1', { goal: '   ' })).rejects.toThrow('goal is required')
    await expect(runner.start('room-1', { goal: 'go', agentOrder: ['agent-a'] })).rejects.toThrow('at least 2 agents')
    await expect(runner.start('room-1', { goal: 'go', agentOrder: ['agent-a', 'stranger'] })).rejects.toThrow('at least 2 agents')

    const single = harness({ agents: [DEFAULT_AGENTS[0]] })
    await expect(single.runner.start('room-1', { goal: 'go' })).rejects.toThrow('at least 2 agents')
  })

  it('rejects a duplicate start while a discussion is already running', async () => {
    const { runner } = harness()
    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    await expect(runner.start('room-1', { goal: 'go again' })).rejects.toMatchObject({ status: 409 })
    await waitForDone(runner, 'room-1')
  })

  it('drives two agents round by round in the configured order with injected prompts, then reports on convergence', async () => {
    const { runner, speechCalls, systemMessages } = harness()
    judgeMock
      .mockResolvedValueOnce(judgeJson())                     // round 1: not converged
      .mockResolvedValueOnce(judgeJson({ converged: true }))  // round 2: converged (streak 1 — not enough)
      .mockResolvedValueOnce(judgeJson({ converged: true }))  // round 3: converged (streak 2 → ends)

    await runner.start('room-1', { goal: '决定发布策略', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(3)
    expect(final.reportMessageId).toBe('')
    expect(judgeMock).toHaveBeenCalledTimes(3)

    // 2 agents x 3 rounds, then the reporter (order[0] = agent-a) closes with the report.
    const calls = speechCalls()
    expect(calls.map(call => call.agentId)).toEqual(['agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a'])

    // Speech prompts carry the goal and per-agent identity.
    expect(calls[0].content).toContain('【讨论目标】决定发布策略')
    expect(calls[0].content).toContain('【你的身份】Agent A（p-a）')
    expect(calls[1].content).toContain('【你的身份】Agent B（p-b）')
    // Round 2 speech inherits the judge's previous assessment.
    expect(calls[2].content).toContain('【裁判上轮评估】双方观点已清晰')
    // The closing call is the reporting phase.
    expect(calls[6].content).toContain('最终交付阶段')
    expect(calls[6].content).toContain('【讨论目标】决定发布策略')

    // Judge notes are broadcast and echoed to the room as system messages.
    const systemText = systemMessages.map(item => item.content).join('\n')
    expect(systemText).toContain('第1轮评估')
    expect(systemText).toContain('第2轮评估')
    expect(systemText).toContain('第3轮评估')
  })

  it('forces a report when maxRounds is reached without convergence', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson())

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
    expect(calls.at(-1)?.content).toContain('已达轮次/消息上限')
  })

  it('appends registered attachment paths to the goal so agents know what to read', async () => {
    const { runner, speechCalls, rows } = harness()
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))
    listDocumentsByRoomMock.mockReturnValue([
      { name: 'contract_1mb.txt', file_id: 'gcd_1' },
      { name: '证据清单.pdf', file_id: 'gcd_2' },
    ])

    await runner.start('room-1', {
      goal: '自由讨论这个文件的内容',
      attachments: ['contract_1mb.txt', '证据清单.pdf'],
      maxRounds: 3,
    })
    await waitForDone(runner, 'room-1')

    // The persisted goal includes each attachment with its readable on-disk path.
    const persisted = rows.get('room-1')
    expect(persisted?.goal).toContain('自由讨论这个文件的内容')
    expect(persisted?.goal).toContain('【讨论文件】contract_1mb.txt（路径：group-chat-docs/room-1/gcd_1/contract_1mb.txt）、证据清单.pdf（路径：group-chat-docs/room-1/gcd_2/证据清单.pdf）')

    // Every agent speech prompt carries the attachment reference.
    for (const call of speechCalls()) {
      expect(call.content).toContain('【讨论目标】自由讨论这个文件的内容')
      expect(call.content).toContain('【讨论文件】contract_1mb.txt（路径：group-chat-docs/room-1/gcd_1/contract_1mb.txt）')
    }
  })

  it('rejects attachments that were never registered in the document store', async () => {
    const { runner } = harness()
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))
    listDocumentsByRoomMock.mockReturnValue([])

    await expect(runner.start('room-1', {
      goal: '读文件',
      attachments: ['unmatched.pdf'],
      maxRounds: 1,
    })).rejects.toMatchObject({ status: 400 })

    // No discussion row is persisted for a rejected start.
    expect(await runner.getState('room-1')).toBeNull()
  })

  it('does not terminate on pre-existing room history; only counts messages produced during the discussion', async () => {
    const { runner, speechCalls, setMessageCount } = harness({ messageCount: 60 })
    judgeMock.mockResolvedValue(judgeJson())

    // maxMessages applies to messages *during* this run, not the 60 historical ones.
    await runner.start('room-1', { goal: 'go', maxRounds: 2, maxMessages: 60 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(2) // full 2 rounds ran despite 60 historical msgs
    // All agents spoke (2 rounds x 2 agents) plus the report.
    const calls = speechCalls()
    expect(calls.length).toBe(2 * 2 + 1)
  })

  it('stops early when messages produced during the discussion hit the cap', async () => {
    const { runner, speechCalls, setMessageCount } = harness({ messageCount: 10 })
    judgeMock.mockResolvedValue(judgeJson())

    // Simulate heavy chatter: after the run starts, the room gains enough new
    // messages to cross the (incremental) cap, forcing an early max_rounds stop.
    let started = false
    const origSpeech = speechCalls
    await runner.start('room-1', { goal: 'go', maxRounds: 8, maxMessages: 20 })
    // Pump the counter past the incremental cap right away.
    setMessageCount(10 + 25)
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBeLessThan(8)
    void origSpeech
    void started
    const calls = speechCalls()
    expect(calls.at(-1)?.content).toContain('已达轮次/消息上限')
  })

  it('terminates after two consecutive stalled rounds with a forced report', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ stalled: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.currentRound).toBe(2)
    expect(final.status).toBe('max_rounds') // stalled maps to the forced-report terminal status
    const calls = speechCalls()
    expect(calls.length).toBe(5) // 2 rounds x 2 + 1 report
    expect(calls.at(-1)?.content).toContain('原地打转')
  })

  it('auto-archives the room transcript once the discussion ends (large room)', async () => {
    const { runner, archiveCalls } = harness({ messageCount: 500 })
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    await vi.waitFor(() => expect(archiveCalls).toEqual(['room-1']))
  })

  it('keeps the transcript visible (no auto-archive) for a normal-size discussion', async () => {
    const { runner, archiveCalls } = harness({ messageCount: 40 })
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    await waitForDone(runner, 'room-1')

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(archiveCalls).toEqual([])
  })

  it('auto-archives mid-run every N rounds when the transcript grows large', async () => {
    const { runner, archiveCalls, systemMessages } = harness({ growSubstantivePerSpeech: 10 })
    judgeMock.mockResolvedValue(judgeJson())

    // 2 agents x 5 rounds = 10 speeches, each growing the substantive counter by
    // 10 → 100 substantive messages by round 5, crossing the mid-run threshold
    // (>=60) at exactly the 5th round (DISCUSSION_ROUND_ARCHIVE_EVERY=5).
    await runner.start('room-1', { goal: 'go', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.currentRound).toBe(5)
    // Mid-run archive happened at round 5; the end-of-run auto-archive is skipped
    // (transcript below 500), so archiveRoom was called exactly once.
    await vi.waitFor(() => expect(archiveCalls).toEqual(['room-1']))
    expect(systemMessages.some(item => item.content.includes('已自动归档'))).toBe(true)
  })

  it('rejects a start in another room while the global concurrency cap is reached', async () => {
    const { runner, storage, rows } = harness()
    // Seed an active discussion in a different room to occupy the single global slot.
    storage.saveDiscussion({
      id: 'disc-other',
      roomId: 'room-2',
      goal: 'other goal',
      agentOrder: JSON.stringify(['agent-a', 'agent-b']),
      reporterId: 'agent-a',
      maxRounds: 8,
      maxMessages: 200,
      minRounds: 0,
      judgeProfile: 'default',
      judgeProvider: 'openai',
      judgeModel: 'gpt-test',
      judgeApiMode: 'chat_completions',
      status: 'running',
      currentRound: 2,
      judgeNotes: '[]',
      reportMessageId: '',
      summaryFilePath: '',
      deliverables: '[]',
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(rows.get('room-2')?.status).toBe('running')

    await expect(runner.start('room-1', { goal: 'go' })).rejects.toMatchObject({ status: 409 })
    expect(runner.getState('room-1')).toBeNull() // nothing persisted for room-1
  })

  it('allows a second discussion once the occupying room finishes', async () => {
    const { runner, storage, rows, speechCalls } = harness()
    // Occupy the single global slot with an active row, then flip it terminal so
    // the concurrency cap releases before room-1 starts.
    storage.saveDiscussion({
      id: 'disc-other',
      roomId: 'room-2',
      goal: 'other goal',
      agentOrder: JSON.stringify(['agent-a', 'agent-b']),
      reporterId: 'agent-a',
      maxRounds: 8,
      maxMessages: 200,
      minRounds: 0,
      judgeProfile: 'default',
      judgeProvider: 'openai',
      judgeModel: 'gpt-test',
      judgeApiMode: 'chat_completions',
      status: 'running',
      currentRound: 2,
      judgeNotes: '[]',
      reportMessageId: '',
      summaryFilePath: '',
      deliverables: '[]',
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    rows.get('room-2')!.status = 'converged'
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 2 })
    const final = await waitForDone(runner, 'room-1')
    expect(final.status).toBe('converged')
    expect(speechCalls().length).toBeGreaterThan(0)
  })

  it('reports live agent status during speech so room avatars light up', async () => {
    const { runner, agentStatusLog } = harness()
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 1 })
    await waitForDone(runner, 'room-1')

    // Both agents must have reported a non-ready status while speaking.
    const spokenAgents = new Set(
      agentStatusLog.filter(entry => entry.status !== 'ready').map(entry => entry.agentName),
    )
    expect(spokenAgents.has('Agent A')).toBe(true)
    expect(spokenAgents.has('Agent B')).toBe(true)
    // Every non-ready status is followed by a ready (clear) status.
    for (const agentName of spokenAgents) {
      expect(agentStatusLog.some(entry => entry.agentName === agentName && entry.status === 'ready')).toBe(true)
    }
  })

  it('skips an agent whose speech fails without blocking the round', async () => {
    const { runner, speechCalls } = harness({
      agents: [
        { agentId: 'agent-a', name: 'Agent A', profile: 'p-a', reply: async () => { throw new Error('agent runtime hung') } },
        { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
      ],
    })
    judgeMock
      .mockResolvedValueOnce(judgeJson())                     // round 1: not converged
      .mockResolvedValueOnce(judgeJson({ converged: true }))  // round 2: converged (streak 1)
      .mockResolvedValueOnce(judgeJson({ converged: true }))  // round 3: converged (streak 2 → ends)

    await runner.start('room-1', { goal: 'go', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(3)
    const bCalls = speechCalls().filter(call => call.agentId === 'agent-b')
    expect(bCalls.length).toBe(3) // rounds 1-3 still happened
    expect(bCalls.at(-1)?.content).toContain('第 3/')
  })

  it('keeps running when the judge keeps failing and still reports on the round cap', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockRejectedValue(new Error('provider unavailable'))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    expect(final.lastError).toContain('裁判暂不可用')
    // Every round still advanced exactly one turn per agent; the judge outage
    // never repeats a round or kills the run.
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
    expect(calls.map(call => call.agentId)).toEqual(['agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a', 'agent-b', 'agent-a'])
  })

  it('recovers when the judge succeeds again after a failed round', async () => {
    const { runner } = harness()
    judgeMock
      .mockRejectedValueOnce(new Error('provider unavailable'))  // round 1: outage
      .mockResolvedValueOnce(judgeJson({ converged: true }))     // round 2: converged (streak 1)
      .mockResolvedValueOnce(judgeJson({ converged: true }))     // round 3: converged (streak 2 → ends)

    await runner.start('room-1', { goal: 'go', maxRounds: 5 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(3)
    expect(final.lastError).toBeNull() // cleared once a judge round succeeds
    expect(judgeMock).toHaveBeenCalledTimes(3)
  })

  it('closes at maxRounds without extension, even when the judge keeps reporting progress', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ progress: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    // The soft-cap extension mechanism was removed (b80cee40): maxRounds is the
    // hard ceiling and the runner never extends past it.
    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    expect(final.judgeNotes.every(note => note.progress)).toBe(true)
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
  })

  it('closes at maxRounds without extending when the judge reports no progress', async () => {
    const { runner, speechCalls } = harness()
    judgeMock.mockResolvedValue(judgeJson({ progress: false }))

    await runner.start('room-1', { goal: 'go', maxRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(3)
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
  })

  it('does not count tool plumbing toward the maxMessages budget (substantive speech only)', async () => {
    // 5 raw messages, but only 2 of them are substantive (e.g. agent speeches);
    // the rest are tool results / empty assistant placeholders. maxMessages=3
    // must NOT terminate on the raw count — substantive speech stays under it.
    const { runner, speechCalls } = harness({ messageCount: 5, substantiveMessageCount: 2 })
    judgeMock.mockResolvedValue(judgeJson())

    await runner.start('room-1', { goal: 'go', maxRounds: 4, maxMessages: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('max_rounds')
    expect(final.currentRound).toBe(4) // ran the full 4 rounds despite 5 raw messages
    const calls = speechCalls()
    expect(calls.length).toBe(9) // 4 rounds x 2 agents + 1 report
  })

  it('does not converge before minRounds, even when the judge reports convergence', async () => {
    const { runner, speechCalls } = harness()
    // Every round reports converged; with minRounds=3 the runner must keep going
    // until round 3 even though the streak reaches 2 already at round 2.
    judgeMock.mockResolvedValue(judgeJson({ converged: true }))

    await runner.start('room-1', { goal: 'go', maxRounds: 5, minRounds: 3 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(3) // forced to explore at least 3 rounds
    const calls = speechCalls()
    expect(calls.length).toBe(7) // 3 rounds x 2 agents + 1 report
  })

  it('resets the convergence streak when a round is not converged', async () => {
    const { runner, speechCalls } = harness()
    judgeMock
      .mockResolvedValueOnce(judgeJson({ converged: true }))   // round 1: streak 1
      .mockResolvedValueOnce(judgeJson())                       // round 2: streak reset
      .mockResolvedValueOnce(judgeJson({ converged: true }))   // round 3: streak 1
      .mockResolvedValueOnce(judgeJson({ converged: true }))   // round 4: streak 2 → ends

    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    const final = await waitForDone(runner, 'room-1')

    expect(final.status).toBe('converged')
    expect(final.currentRound).toBe(4) // needs two consecutive converged rounds after the reset
    const calls = speechCalls()
    expect(calls.length).toBe(9) // 4 rounds x 2 agents + 1 report
  })



  it('stops an active discussion and forces a stopped report', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { runner } = harness({
      agents: [
        { agentId: 'agent-a', name: 'Agent A', profile: 'p-a', reply: async () => { await gate; throw new Error('interrupted') } },
        { agentId: 'agent-b', name: 'Agent B', profile: 'p-b' },
      ],
      interruptRoom: async () => { release() },
    })
    judgeMock.mockResolvedValue(judgeJson())

    await runner.start('room-1', { goal: 'go', maxRounds: 8 })
    await vi.waitFor(() => {
      if (runner.getState('room-1')?.status !== 'running') throw new Error('discussion not started yet')
    })
    const stopped = await runner.stop('room-1')

    expect(stopped.status).toBe('stopped')
    expect(runner.isActive('room-1')).toBe(false)
  })

  it('marks in-flight discussions as failed on recovery', () => {
    const { runner, storage, rows } = harness()
    storage.saveDiscussion({
      id: 'disc-old',
      roomId: 'room-1',
      goal: 'go',
      agentOrder: JSON.stringify(['agent-a', 'agent-b']),
      reporterId: 'agent-a',
      maxRounds: 8,
      maxMessages: 60,
      minRounds: 0,
      judgeProfile: 'default',
      judgeProvider: 'openai',
      judgeModel: 'gpt-test',
      judgeApiMode: 'chat_completions',
      status: 'running',
      currentRound: 3,
      judgeNotes: '[]',
      reportMessageId: '',
      summaryFilePath: '',
      deliverables: '[]',
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    })

    runner.recoverInterrupted()

    expect(rows.get('room-1')?.status).toBe('failed')
    expect(runner.getState('room-1')?.lastError).toBe('Discussion run was interrupted')
  })
})
