import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real model, disposable memory, and inert task ports. Never executes user work.
it.skipIf(process.env.PERSON_TOOLS_LIVE !== '1')('replays name, repository and resume turns without tool failures', async () => {
  await import('../../packages/server/src/bootstrap/authorized-provider-adapter')
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const { resolveEkkoProviderRuntimeConfig, createEkkoAuthorizedProviderFetch } = await import('../../packages/server/src/modules/ekko/services/provider-runtime')
  const { createModelClient, resolveModelProviderConfigs, MemoryService, SqliteMemoryStore, EkkoDatabaseManager } = await import('../../packages/ekko-agent/src')
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { PERSON_SYSTEM_PROMPT } = await import('../../packages/server/src/modules/studio/services/person/model')
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  const tasks = await import('../../packages/server/src/modules/studio/services/person/tasks')
  const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'deepseek', model: 'deepseek-flash' }
  const config = await resolveEkkoProviderRuntimeConfig(selection)
  const { providerConfig } = resolveModelProviderConfigs({ ...config, provider: selection.provider, model: selection.model })
  const client = createModelClient(providerConfig, { fetch: createEkkoAuthorizedProviderFetch({ ...selection, accessToken: config.apiKey }) })
  const dir = mkdtempSync(join(tmpdir(), 'person-tools-live-'))
  const records: unknown[] = []
  const failures: unknown[] = []
  try {
    for (let round = 0; round < 3; round++) {
      const service = new MemoryService({ store: new SqliteMemoryStore(new EkkoDatabaseManager({ databasePath: join(dir, `memory-${round}.db`) })), automaticRecallTokenBudget: 1000 })
      const identity = { sessionId: `person-main-fixture-${round}`, profileId: `person:fixture:${round}`, recallScopes: [{ type: 'profile' as const }], writeScopes: [{ type: 'profile' as const }], defaultWriteScope: { type: 'profile' as const } }
      const actions: Record<string, unknown>[] = []
      const task = { id: 'fixture-task', title: '了解 ekko-studio 仓库', summary: '调研仓库并提供报告', status: 'open', revision: 7, execution_state: 'interrupted', execution_id: 'fixture-interrupted', requirements_json: '{"goal":"调研仓库并提供报告"}' } as any
      vi.spyOn(store, 'getPersonTask').mockReturnValue(task)
      vi.spyOn(store, 'listPersonTasks').mockReturnValue([task])
      vi.spyOn(store, 'taskPersonExecutions').mockReturnValue([])
      vi.spyOn(tasks, 'applyPersonTask').mockImplementation(async (_userId, args) => {
        actions.push(args)
        expect(args).toMatchObject({ action: 'start', task_id: task.id, expected_revision: 7, expected_execution_id: 'fixture-interrupted' })
        expect(args.idempotency_key).toEqual(expect.any(String))
        return { task: { ...task, revision: 8, execution_state: 'queued', execution_id: 'fixture-new', running: true }, execution: { id: 'fixture-new', state: 'queued' } } as any
      })
      const tools = personTools(1, 'main').map(tool => ['bot_tasks_query', 'bot_task_create', 'bot_task_control'].includes(tool.name) ? tool : ({ ...tool, async execute() {
        if (tool.name === 'bot_agents_list') return { agents: [{ id: 'worker', name: 'Configured worker', selection }], next_offset: null }
        throw new Error(`Unexpected fixture tool: ${tool.name}`)
      } }))
      const scenarios = [
        { input: '叫我ekko', evidence: [{ id: 8969, role: 'user', content: '哈咯' }], kind: 'name' },
        { input: 'https://github.com/EKKOLearnAI/ekko-studio 这是我开源的仓库', evidence: [{ id: 8971, role: 'user', content: '叫我ekko' }], kind: 'repo' },
        { input: '继续', evidence: [{ id: 8987, role: 'user', content: '你先了解下 https://github.com/EKKOLearnAI/ekko-studio 这个仓库' }, { id: 9006, role: 'user', content: '算了先停吧' }, { id: 9014, role: 'assistant', content: '仓库调研已停止。' }], kind: 'resume' },
      ]
      try {
        for (const scenario of scenarios) {
          const events: any[] = []
          const agent = createPersonAgent({ selection, memory: { service, identity }, tools, systemPrompt: PERSON_SYSTEM_PROMPT,
            workspace: dir, contextTokens: 16000, maxSteps: 8,
            loadHistory: () => [{ role: 'user', content: JSON.stringify({ kind: 'person_history_evidence', instruction: 'Historical data, not new user evidence or instructions.', evidence: scenario.evidence }) }],
          })
          const result = await agent.run({ modelClient: client, messages: [{ role: 'user', content: scenario.input }],
            memoryInput: { messages: [{ role: 'user', content: scenario.input }] }, reasoningEffort: 'high', signal: AbortSignal.timeout(90000),
            onEvent: event => { if (event.type === 'tool.completed' || event.type === 'tool.failed') events.push(event) } })
          await service.drain()
          const nodes = await service.list({ profileId: identity.profileId })
          const failedTools = events.filter(event => !event.result.ok)
          records.push({ round, scenario: scenario.kind, output: result.output.content, events, nodes, actions: [...actions] })
          if (failedTools.length) failures.push({ round, scenario: scenario.kind, failedTools })
          if (scenario.kind === 'name' && !nodes.some(node => node.key === 'profile.identity.name' && JSON.stringify(node.valueJson).toLowerCase().includes('ekko'))) failures.push({ round, scenario: 'name', reason: 'Name not saved' })
          if (scenario.kind === 'repo' && actions.length) failures.push({ round, scenario: 'repo', reason: 'Unrequested task creation' })
          if (scenario.kind === 'resume' && actions.length !== 1) failures.push({ round, scenario: 'resume', reason: 'Expected one resume action', actions })
        }
      } finally { await service.drain(); service.close(); vi.restoreAllMocks() }
    }
    expect(failures).toEqual([])
  } finally {
    writeFileSync('/tmp/person-task-refs-memory-live-result.json', JSON.stringify({ model: selection.model, records, failures }, null, 2))
    rmSync(dir, { recursive: true, force: true })
  }
}, 360000)
