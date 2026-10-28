import { expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'

// Both versions run this exact fixture against the same provider. Model calls
// are real; task persistence/execution ports are inert and never touch user work.
it.skipIf(process.env.PERSON_TASK_TOOLS_LIVE !== '1')('compares task intents and stale-state recovery with real model calls', async () => {
  await import('../../packages/server/src/bootstrap/authorized-provider-adapter')
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const { resolveEkkoProviderRuntimeConfig, createEkkoAuthorizedProviderFetch } = await import('../../packages/server/src/modules/ekko/services/provider-runtime')
  const { createModelClient, resolveModelProviderConfigs, countTextTokens } = await import('../../packages/ekko-agent/src')
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  const { PERSON_SYSTEM_PROMPT } = await import('../../packages/server/src/modules/studio/services/person/model')
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  const tasks = await import('../../packages/server/src/modules/studio/services/person/tasks')
  const { personError } = await import('../../packages/server/src/modules/studio/contracts/person')
  const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'deepseek', model: 'deepseek-flash' }
  const config = await resolveEkkoProviderRuntimeConfig(selection)
  const { providerConfig } = resolveModelProviderConfigs({ ...config, provider: selection.provider, model: selection.model })
  const client = createModelClient(providerConfig, { fetch: createEkkoAuthorizedProviderFetch({ ...selection, accessToken: config.apiKey }) })
  const variant = personTools(1, 'main').some(tool => tool.name === 'bot_task_control') ? 'refs' : 'baseline'
  const records: any[] = [], failures: any[] = []
  const cases = [
    { name: 'create', input: '新建一个后台任务，计算 123 加 456 的结果。立即开始。', state: 'idle', status: 'open', expected: ['create'] },
    { name: 'resume', input: '继续刚才被我停止的仓库调研任务。', state: 'interrupted', status: 'open', expected: ['start'] },
    { name: 'close', input: '关闭那个已经停止的仓库调研任务，以后不继续了。', state: 'interrupted', status: 'open', expected: ['close'] },
    { name: 'reopen', input: '重新打开已经完成的仓库调研任务，并继续执行。', state: 'finished', status: 'completed', expected: ['reopen', 'start'] },
    { name: 'stop', input: '停止正在执行的仓库调研任务，保留任务。', state: 'running', status: 'open', expected: ['stop'] },
    { name: 'stale-stop', input: '停止当前仓库调研任务。如果查询后执行变了，重新查清楚再停止当前执行。', state: 'running', status: 'open', expected: ['stop'] },
  ]
  try {
    for (let round = 0; round < 2; round++) for (const scenario of cases) {
      let task: any = { id: 'fixture-task', owner_user_id: 1, bot_id: 'person:1', title: '仓库调研', summary: '了解 ekko-studio 仓库', requirements_json: '{"goal":"了解仓库"}', status: scenario.status, revision: 7, running: scenario.state === 'running', execution_state: scenario.state, execution_id: 'fixture-execution' }
      const calls: any[] = [], applied: string[] = [], receipts = new Map<string, any>(), events: any[] = [], usages: any[] = []
      let queryCount = 0, changed = false, created = false
      vi.spyOn(store, 'listPersonTasks').mockImplementation(() => { queryCount++; return scenario.name === 'create' && !created ? [] : [structuredClone(task)] })
      vi.spyOn(store, 'getPersonTask').mockImplementation(() => { queryCount++; return structuredClone(task) })
      vi.spyOn(store, 'taskPersonExecutions').mockReturnValue([])
      vi.spyOn(store, 'listAssignablePersonGoals').mockReturnValue([])
      vi.spyOn(tasks, 'applyPersonTask').mockImplementation(async (_userId, args) => {
        calls.push(structuredClone(args))
        if (typeof args.idempotency_key !== 'string') throw personError('idempotency_key is required')
        const prior = receipts.get(args.idempotency_key)
        if (prior) return structuredClone(prior)
        if (scenario.name === 'stale-stop' && !changed) { changed = true; task.execution_id = 'fixture-replacement' }
        if (args.action !== 'create') {
          if (args.task_id !== task.id || args.expected_revision !== task.revision) throw personError('Task changed or expected_revision missing; query again', 409)
          if (args.expected_execution_id !== undefined && args.expected_execution_id !== task.execution_id) throw personError('Execution changed; query again', 409)
          if (args.action === 'stop' && args.execution_id !== task.execution_id) throw personError('Execution changed; query again', 409)
        }
        if (args.action === 'create' && (!args.title || !args.goal)) throw personError('title and goal required')
        if (args.action === 'start' && task.status !== 'open') throw personError('Task must be open', 409)
        if (args.action === 'create') { created = true; task = { ...task, title: args.title, summary: args.goal, requirements_json: JSON.stringify({ goal: args.goal }) } }
        if (args.action === 'create' || args.action === 'start') task = { ...task, status: 'open', running: true, execution_id: 'fixture-started', execution_state: 'queued' }
        if (args.action === 'stop') task = { ...task, running: false, execution_state: 'interrupted' }
        if (args.action === 'close') task = { ...task, status: 'closed' }
        if (args.action === 'reopen') task = { ...task, status: 'open' }
        task.revision++
        applied.push(String(args.action))
        const result = { task: structuredClone(task), execution: { id: task.execution_id, state: task.execution_state } }
        receipts.set(args.idempotency_key, structuredClone(result))
        return result as any
      })
      const tools = personTools(1, 'main').map(tool => ['bot_tasks_query', 'bot_task_create', 'bot_task_control', 'bot_task_apply'].includes(tool.name) ? tool : ({ ...tool, async execute() {
        if (tool.name === 'bot_agents_list') return { agents: [{ id: 'worker', name: 'Configured worker', selection }], next_offset: null }
        if (tool.name === 'bot_schedules_query' || tool.name === 'bot_execution_events') return []
        if (tool.name === 'bot_artifact_read') return { content: '', next_offset: null }
        if (tool.name === 'bot_context_search') return { evidence: [], coverage: { complete: true } }
        throw new Error(`Unexpected fixture tool: ${tool.name}`)
      } }))
      const started = Date.now()
      try {
        const agent = createPersonAgent({ selection, tools, systemPrompt: PERSON_SYSTEM_PROMPT, workspace: '/tmp/person-task-tools-live', contextTokens: 16000, maxSteps: 10 })
        const result = await agent.run({ modelClient: client, messages: [{ role: 'user', content: scenario.input }], reasoningEffort: 'high', signal: AbortSignal.timeout(90000), onEvent: event => {
          if (event.type === 'tool.completed' || event.type === 'tool.failed') events.push(event)
          if (event.type === 'model.usage') usages.push(event.usage)
        } })
        const failed = events.filter(event => !event.result.ok)
        const unexpected = failed.length !== (scenario.name === 'stale-stop' ? 1 : 0)
        if (JSON.stringify(applied) !== JSON.stringify(scenario.expected) || unexpected) failures.push({ round, scenario: scenario.name, applied, failed })
        records.push({ round, scenario: scenario.name, output: result.output.content, elapsedMs: Date.now() - started, queryCount, schemaTokens: countTextTokens(JSON.stringify(tools.map(({ execute: _, ...tool }) => tool))), calls, applied, events, usages })
      } catch (error) { failures.push({ round, scenario: scenario.name, error: String(error) }) }
      finally { vi.restoreAllMocks(); writeFileSync(`/tmp/person-task-tools-live-${variant}.json`, JSON.stringify({ variant, model: selection.model, records, failures }, null, 2)) }
    }
    expect(failures).toEqual([])
  } finally {
    writeFileSync(`/tmp/person-task-tools-live-${variant}.json`, JSON.stringify({ variant, model: selection.model, records, failures }, null, 2))
  }
}, 1200000)
