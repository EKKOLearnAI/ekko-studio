import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  DelegateTaskTool,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MODEL_MAX_RETRIES,
  DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES,
  ModelProviderError,
  ViewImageTool,
  buildSystemPrompt,
} from '../../packages/ekko-agent/src/index'
import type {
  AgentRuntimeEvent,
  AgentTool,
  AgentToolProvider,
  ModelEvent,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '../../packages/ekko-agent/src/index'

function modelClient(responder: (request: ModelRequest, call: number) => ModelResponse | Promise<ModelResponse>): ModelClient {
  let call = 0
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async (request: ModelRequest) => responder(request, ++call)),
    stream: vi.fn(),
  }
}

function skillContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function streamingModelClient(events: ModelEvent[]): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(),
    stream: vi.fn(async function *stream() {
      for (const event of events) yield event
    }),
  }
}

function emptyStreamingWithCreateFallback(response: ModelResponse): ModelClient {
  return {
    provider: 'test',
    requestStyle: 'custom-runtime',
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    create: vi.fn(async () => response),
    stream: vi.fn(async function *stream() {
      yield { type: 'done', response: { finishReason: 'stop' } }
    }),
  }
}

describe('ekko-agent runtime', () => {
  it('runs automatic recovery tools before the first model request', async () => {
    let active = true
    const repair = vi.fn(async () => {
      active = false
      return { ok: true, content: 'persistent database repaired' }
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'ekko_repair_database',
        parameters: { type: 'object', properties: {} },
      },
      execute: repair,
    })
    const client = modelClient(() => ({ content: 'continued after repair' }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools,
      recoveryDirective: () => ({
        active,
        automaticToolCalls: active
          ? [{ name: 'ekko_repair_database', arguments: { strategy: 'retry' } }]
          : [],
        allowedToolNames: ['ekko_repair_database'],
        reminder: 'continue recovery',
      }),
    })

    const result = await runtime.run({ messages: ['hello'] })

    expect(repair).toHaveBeenCalledWith({ strategy: 'retry' }, expect.any(Object))
    expect(result.output.content).toBe('continued after repair')
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', step: 0, toolName: 'ekko_repair_database' }),
    ]))
  })

  it('does not let a model end or ask permission while recovery remains active', async () => {
    const requests: ModelRequest[] = []
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'terminal_exec',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(async () => ({ ok: true, content: 'unused' })),
    })
    const client = modelClient(request => {
      requests.push(request)
      return { content: 'Should I repair it?' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools,
      maxSteps: 2,
      recoveryDirective: () => ({
        active: true,
        automaticToolCalls: [],
        allowedToolNames: ['terminal_exec'],
        reminder: 'Repair now without asking the user.',
      }),
    })

    const result = await runtime.run({ messages: ['hello'] })

    expect(result.output.finishReason).toBe('max_steps')
    expect(requests).toHaveLength(2)
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolChoice: 'required',
        tools: [expect.objectContaining({ name: 'terminal_exec' })],
      }),
    ]))
    expect(result.events.filter(event => event.type === 'model.message')).toEqual([])
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: 'Repair now without asking the user.' }),
    ]))
  })

  it('runs a model request without tools', async () => {
    const client = modelClient(() => ({
      content: 'hello',
      model: 'test-model',
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => events.push(event.type),
    })

    expect(result.output).toMatchObject({
      role: 'assistant',
      content: 'hello',
      model: 'test-model',
    })
    expect(result.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.message', 'run.completed'])
  })

  it('forwards reasoning controls to model requests', async () => {
    const client = modelClient(request => {
      expect(request).toMatchObject({
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      })
      return { content: 'done' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    await runtime.run({
      messages: ['hi'],
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
    })
  })

  it('estimates provider-visible context without starting a model run', async () => {
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'estimate_only',
        description: 'Included in context estimates',
        parameters: { type: 'object' },
      },
      async execute() {
        return { ok: true, content: 'unused' }
      },
    })
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const estimate = await runtime.estimateContext({
      messages: ['hello'],
      metadata: { session_id: 'estimate-session' },
    })

    expect(estimate.messageCount).toBe(2)
    expect(estimate.toolCount).toBe(1)
    expect(estimate.systemPromptTokens).toBeGreaterThan(0)
    expect(estimate.messageTokens).toBeGreaterThan(0)
    expect(client.create).not.toHaveBeenCalled()
    expect(client.stream).not.toHaveBeenCalled()
  })

  it('includes assistant reasoning in provider-visible context estimates', async () => {
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: '',
    })
    const withoutReasoning = await runtime.estimateContext({
      messages: [
        { role: 'assistant', content: 'Previous answer.' },
        { role: 'user', content: 'Continue.' },
      ],
    })
    const withReasoning = await runtime.estimateContext({
      messages: [
        {
          role: 'assistant',
          content: 'Previous answer.',
          reasoning: { text: 'A long hidden reasoning trace that is replayed to the provider.' },
        },
        { role: 'user', content: 'Continue.' },
      ],
    })

    expect(withReasoning.messageTokens).toBeGreaterThan(withoutReasoning.messageTokens)
    expect(withReasoning.contextTokens - withoutReasoning.contextTokens)
      .toBe(withReasoning.messageTokens - withoutReasoning.messageTokens)
  })

  it('uses one provider reasoning-token estimate instead of counting text and native metadata again', async () => {
    const client = modelClient(() => ({ content: 'must not run' }))
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: '',
    })
    const base = await runtime.estimateContext({
      messages: [{ role: 'assistant', content: 'Previous answer.' }],
    })
    const withReasoning = await runtime.estimateContext({
      messages: [{
        role: 'assistant',
        content: 'Previous answer.',
        reasoning: {
          text: 'Visible summary that must not be counted a second time.',
          estimatedTokens: 123,
          native: {
            format: 'openai-responses-items',
            data: [{ type: 'reasoning', encrypted_content: 'opaque-native-data' }],
          },
        },
      }],
    })

    expect(withReasoning.messageTokens - base.messageTokens).toBe(123)
  })

  it('emits one model usage event for each completed non-streaming model call', async () => {
    const client = modelClient(() => ({
      content: 'hello',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        reasoningTokens: 2,
      },
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const usageEvents: any[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.usage') usageEvents.push(event)
      },
    })

    expect(usageEvents).toEqual([{
      type: 'model.usage',
      runId: expect.any(String),
      step: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        reasoningTokens: 2,
      },
    }])
  })

  it('collapses repeated streaming usage updates into one event per model call', async () => {
    const client = streamingModelClient([
      { type: 'text-delta', text: 'ok' },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 } },
      { type: 'done', response: { finishReason: 'stop' } },
    ])
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const usageEvents: any[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.usage') usageEvents.push(event)
      },
    })

    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      step: 1,
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 },
    })
  })

  it('emits model reasoning before the assistant message', async () => {
    const client = modelClient(() => ({
      content: 'answer',
      reasoning: 'thinking path',
    }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []
    const reasoning: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        events.push(event.type)
        if (event.type === 'model.reasoning') reasoning.push(event.text)
      },
    })

    expect(result.output.reasoning).toEqual({ text: 'thinking path' })
    expect(reasoning).toEqual(['thinking path'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.reasoning', 'model.message', 'run.completed'])
  })

  it('streams model text deltas before the final assistant message', async () => {
    const client = streamingModelClient([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'done', response: { finishReason: 'stop' } },
    ])
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []
    const deltas: string[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        events.push(event.type)
        if (event.type === 'model.delta') deltas.push(event.text)
      },
    })

    expect(client.create).not.toHaveBeenCalled()
    expect(client.stream).toHaveBeenCalledTimes(1)
    expect(result.output.content).toBe('Hello')
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(events).toEqual(['run.started', 'model.started', 'context.estimated', 'model.delta', 'model.delta', 'model.message', 'run.completed'])
  })

  it('falls back to non-streaming create when a provider stream returns no output', async () => {
    const client = emptyStreamingWithCreateFallback({ content: 'fallback answer', finishReason: 'stop' })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    const result = await runtime.run({ messages: ['hi'] })

    expect(result.output.content).toBe('fallback answer')
    expect(client.stream).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).toMatchObject({ stream: false })
  })

  it('executes tool calls and continues the model loop', async () => {
    const echoTool: AgentTool = {
      definition: {
        name: 'echo',
        description: 'Echo text',
        parameters: { type: 'object' },
      },
      async execute(input) {
        return { ok: true, content: String(input.text || '') }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(echoTool)
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '继续检查:',
          toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'from-tool' } }],
          finishReason: 'tool_calls',
        }
      : { content: 'tool said from-tool', finishReason: 'stop' })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const result = await runtime.run({ messages: ['use echo'] })

    expect(result.output.content).toBe('tool said from-tool')
    expect(result.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'use echo' },
      { role: 'assistant', content: '继续检查。', toolCalls: [{ id: 'call_1', name: 'echo' }] },
      { role: 'tool', toolCallId: 'call_1', name: 'echo', content: 'from-tool' },
      { role: 'assistant', content: 'tool said from-tool' },
    ])
    expect(result.steps.map(step => step.type)).toEqual(['model', 'tool', 'model'])
  })

  it('executes explicitly parallel-safe tool calls concurrently and preserves result order', async () => {
    let releaseFirst!: () => void
    let signalSecondStarted!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondStarted = new Promise<void>((resolve) => {
      signalSecondStarted = resolve
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'parallel_probe', description: 'parallel probe', parameters: { type: 'object' } },
      concurrency: 'parallel',
      async execute(input) {
        const label = String(input.label)
        if (label === 'first') await firstRelease
        else signalSecondStarted()
        return { ok: true, content: label }
      },
    })
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'parallel_probe', arguments: { label: 'first' } },
            { id: 'call-2', name: 'parallel_probe', arguments: { label: 'second' } },
          ],
          finishReason: 'tool_calls',
        }
      : { content: 'done', finishReason: 'stop' })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const run = runtime.run({ messages: ['run both probes'] })
    const startedTogether = await Promise.race([
      secondStarted.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200)),
    ])
    releaseFirst()
    const result = await run

    expect(startedTogether).toBe(true)
    expect(result.messages.filter(message => message.role === 'tool')).toMatchObject([
      { toolCallId: 'call-1', content: 'first' },
      { toolCallId: 'call-2', content: 'second' },
    ])
    expect(result.steps.filter(step => step.type === 'tool').map(step => step.toolCallId))
      .toEqual(['call-1', 'call-2'])
  })

  it('keeps serial tools as barriers between parallel-safe segments', async () => {
    let activeParallelCalls = 0
    let barrierStartedWhileParallel = false
    let parallelStartedBeforeBarrierFinished = false
    let barrierFinished = false
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'parallel_segment', description: 'parallel segment', parameters: { type: 'object' } },
      concurrency: 'parallel',
      async execute(input) {
        if (input.phase === 'after' && !barrierFinished) parallelStartedBeforeBarrierFinished = true
        activeParallelCalls += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        activeParallelCalls -= 1
        return { ok: true, content: String(input.phase) }
      },
    })
    tools.register({
      definition: { name: 'serial_barrier', description: 'serial barrier', parameters: { type: 'object' } },
      async execute() {
        barrierStartedWhileParallel = activeParallelCalls > 0
        barrierFinished = true
        return { ok: true, content: 'barrier' }
      },
    })
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [
            { id: 'before-1', name: 'parallel_segment', arguments: { phase: 'before-1' } },
            { id: 'before-2', name: 'parallel_segment', arguments: { phase: 'before-2' } },
            { id: 'barrier', name: 'serial_barrier', arguments: {} },
            { id: 'after-1', name: 'parallel_segment', arguments: { phase: 'after' } },
            { id: 'after-2', name: 'parallel_segment', arguments: { phase: 'after' } },
          ],
          finishReason: 'tool_calls',
        }
      : { content: 'done', finishReason: 'stop' })

    const result = await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['run segments'] })

    expect(barrierStartedWhileParallel).toBe(false)
    expect(parallelStartedBeforeBarrierFinished).toBe(false)
    expect(result.messages.filter(message => message.role === 'tool').map(message => message.toolCallId))
      .toEqual(['before-1', 'before-2', 'barrier', 'after-1', 'after-2'])
  })

  it('limits parallel-safe tool execution to eight calls', async () => {
    let activeCalls = 0
    let maxActiveCalls = 0
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'bounded_parallel', description: 'bounded parallel tool', parameters: { type: 'object' } },
      concurrency: 'parallel',
      async execute(input) {
        activeCalls += 1
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
        await new Promise(resolve => setTimeout(resolve, 10))
        activeCalls -= 1
        return { ok: true, content: String(input.index) }
      },
    })
    const toolCalls = Array.from({ length: 12 }, (_, index) => ({
      id: `bounded-${index}`,
      name: 'bounded_parallel',
      arguments: { index },
    }))
    const client = modelClient((_request, call) => call === 1
      ? { content: '', toolCalls, finishReason: 'tool_calls' }
      : { content: 'done', finishReason: 'stop' })

    const result = await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['run bounded tools'] })

    expect(maxActiveCalls).toBe(8)
    expect(result.messages.filter(message => message.role === 'tool').map(message => message.toolCallId))
      .toEqual(toolCalls.map(toolCall => toolCall.id))
  })

  it('requests model recovery without blocking later serial tools in the same batch', async () => {
    let serialToolExecuted = false
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'parallel_failure', description: 'parallel failure', parameters: { type: 'object' } },
      concurrency: 'parallel',
      async execute(input) {
        return { ok: false, content: `failed-${String(input.index)}`, error: 'failed' }
      },
    })
    tools.register({
      definition: { name: 'serial_after_failures', description: 'serial tool', parameters: { type: 'object' } },
      async execute() {
        serialToolExecuted = true
        return { ok: true, content: 'continued after recovery request' }
      },
    })
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [
            { id: 'failure-1', name: 'parallel_failure', arguments: { index: 1 } },
            { id: 'failure-2', name: 'parallel_failure', arguments: { index: 2 } },
            { id: 'serial-after', name: 'serial_after_failures', arguments: {} },
          ],
          finishReason: 'tool_calls',
        }
      : { content: 'recovered', finishReason: 'stop' })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools,
      toolFailureRecoveryThreshold: 2,
    })
    const events: string[] = []

    const result = await runtime.run({
      messages: ['recover after failures'],
      onEvent: event => events.push(event.type),
    })

    expect(serialToolExecuted).toBe(true)
    expect(result.output).toMatchObject({ content: 'recovered', finishReason: 'stop' })
    expect(result.messages.filter(message => message.role === 'tool').map(message => message.toolCallId))
      .toEqual(['failure-1', 'failure-2', 'serial-after'])
    expect(events).toContain('run.tool_recovery_required')
  })

  it('waits for foreground delegated tasks and hides delegation from the child', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'delegate-1',
            name: 'delegate_task',
            arguments: {
              goal: 'Inspect the implementation',
              context: 'Focus on runtime.ts',
              mode: 'foreground',
            },
          }],
          finishReason: 'tool_calls',
        }
      }
      if (call === 2) return { content: 'Child inspection result', finishReason: 'stop' }
      return { content: 'Parent used the child result', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Delegate this work'],
      metadata: { session_id: 'foreground-session' },
      onEvent: event => events.push(event),
    })

    expect(result.output.content).toBe('Parent used the child result')
    const childPrompt = requests[1].messages.find(message => message.role === 'user')?.content
    expect(childPrompt).toContain('Inspect the implementation')
    expect(childPrompt).toContain('Focus on runtime.ts')
    expect(requests[1].tools).toBeUndefined()
    expect(requests[1].toolChoice).toBeUndefined()
    expect(result.steps.find(step => step.type === 'tool')).toMatchObject({
      type: 'tool',
      toolName: 'delegate_task',
      result: {
        ok: true,
        data: {
          mode: 'foreground',
          status: 'completed',
          output: 'Child inspection result',
        },
      },
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.start',
        goal: 'Inspect the implementation',
        background: false,
      }),
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'completed',
        background: false,
      }),
    ]))
  })

  it('keeps background delegated tasks alive after the parent run completes', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    let call = 0
    let finishChild!: (response: ModelResponse) => void
    const childResponse = new Promise<ModelResponse>((resolve) => {
      finishChild = resolve
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async () => {
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'delegate-bg',
              name: 'delegate_task',
              arguments: { goal: 'Run validation', mode: 'background' },
            }],
            finishReason: 'tool_calls',
          }
        }
        if (call === 2) return childResponse
        return { content: 'Background task started', finishReason: 'stop' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Start it in the background'],
      metadata: { session_id: 'background-session' },
      onEvent: event => events.push(event),
    })

    expect(result.output.content).toBe('Background task started')
    expect(runtime.hasBackgroundTasks('background-session')).toBe(true)
    expect(events.some(event => event.type === 'subagent.complete')).toBe(false)

    finishChild({
      content: 'Validation passed',
      finishReason: 'stop',
      usage: {
        costUsd: 0.04,
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 5,
        reasoningTokens: 2,
      },
    })
    await vi.waitFor(() => {
      expect(runtime.hasBackgroundTasks('background-session')).toBe(false)
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'completed',
        background: true,
        summary: 'Validation passed',
        output: 'Validation passed',
        costUsd: 0.04,
        costSource: 'reported',
        childRunId: expect.any(String),
        apiCalls: 1,
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 5,
        reasoningTokens: 2,
        continuationContext: expect.objectContaining({
          version: 1,
          originRunId: result.runId,
          originStep: 1,
          memoryPolicy: 'disabled',
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', toolCalls: expect.any(Array) }),
            expect.objectContaining({ role: 'tool', toolCallId: 'delegate-bg' }),
          ]),
        }),
      }),
    ]))
  })

  it('waits for the complete parent tool batch before publishing a fast background result', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    let releaseSlowTool!: () => void
    let slowToolStarted!: () => void
    const slowToolStart = new Promise<void>((resolve) => {
      slowToolStarted = resolve
    })
    const slowToolRelease = new Promise<void>((resolve) => {
      releaseSlowTool = resolve
    })
    tools.register({
      definition: {
        name: 'slow_echo',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        slowToolStarted()
        await slowToolRelease
        return { ok: true, content: 'slow tool finished' }
      },
    })
    const client = modelClient((_request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'delegate-fast',
              name: 'delegate_task',
              arguments: { goal: 'Finish immediately', mode: 'background' },
            },
            {
              id: 'slow-sibling',
              name: 'slow_echo',
              arguments: {},
            },
          ],
          finishReason: 'tool_calls',
        }
      }
      if (call === 2) return { content: 'Fast child result', finishReason: 'stop' }
      return { content: 'Parent finished its tool batch', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const parentRun = runtime.run({
      messages: ['Start both tools'],
      metadata: { session_id: 'fast-background-session' },
      onEvent: event => events.push(event),
    })
    await slowToolStart
    await Promise.resolve()
    expect(events.some(event => event.type === 'subagent.complete')).toBe(false)

    releaseSlowTool()
    await parentRun
    await vi.waitFor(() => {
      expect(events.some(event => event.type === 'subagent.complete')).toBe(true)
    })
    const completed = events.find(event => event.type === 'subagent.complete')
    expect(completed.continuationContext.messages.map((message: any) => message.role))
      .toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(completed.continuationContext.messages.filter((message: any) => message.role === 'tool'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'delegate-fast' }),
        expect.objectContaining({ toolCallId: 'slow-sibling', content: 'slow tool finished' }),
      ]))
  })

  it('removes and rejects background delegation when the run disables it', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'delegate-disabled',
            name: 'delegate_task',
            arguments: { goal: 'Run validation later', mode: 'background' },
          }],
          finishReason: 'tool_calls',
        }
      }
      return { content: 'Background delegation was unavailable.', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    const result = await runtime.run({
      messages: ['Do the work'],
      metadata: { session_id: 'no-background-session' },
      backgroundDelegationEnabled: false,
      onEvent: event => events.push(event),
    })

    const delegateDefinition = requests[0].tools?.find(tool => tool.name === 'delegate_task')
    expect((delegateDefinition?.parameters?.properties as any)?.mode?.enum).toEqual(['foreground'])
    expect(result.steps.find(step => step.type === 'tool')).toMatchObject({
      type: 'tool',
      toolName: 'delegate_task',
      result: {
        ok: false,
        error: 'Background subtask delegation is disabled for this run. Use foreground mode.',
      },
    })
    expect(runtime.hasBackgroundTasks('no-background-session')).toBe(false)
    expect(events.some(event => event.type === 'subagent.start')).toBe(false)
  })

  it('aborts detached background delegated tasks by session', async () => {
    const tools = new AgentToolRegistry()
    tools.register(new DelegateTaskTool())
    let call = 0
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async (request) => {
        call += 1
        if (call === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'delegate-bg-abort',
              name: 'delegate_task',
              arguments: { goal: 'Wait indefinitely', mode: 'background' },
            }],
            finishReason: 'tool_calls',
          }
        }
        if (call === 2) {
          return new Promise<ModelResponse>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => {
              const error = new Error('Run aborted.')
              error.name = 'AbortError'
              reject(error)
            }, { once: true })
          })
        }
        return { content: 'Task started', finishReason: 'stop' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    await runtime.run({
      messages: ['Start task'],
      metadata: { session_id: 'abort-background-session' },
      onEvent: event => events.push(event),
    })

    await expect(runtime.abortBackgroundTasks('abort-background-session')).resolves.toBe(1)
    expect(runtime.hasBackgroundTasks('abort-background-session')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'subagent.complete',
        status: 'interrupted',
        background: true,
      }),
    ]))
  })

  it('sanitizes base64 tool results before the next model request', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ekko-runtime-assets-'))
    const dataUrl = `data:image/png;base64,${Buffer.from('runtime-avatar').toString('base64')}`
    const avatarTool: AgentTool = {
      definition: {
        name: 'profiles_list',
        description: 'List profiles',
        parameters: { type: 'object' },
      },
      async execute() {
        return {
          ok: true,
          content: JSON.stringify({ profiles: [{ avatar: { type: 'image', dataUrl } }] }),
        }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(avatarTool)
    let assetUrl = ''
    const client = modelClient((request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_profiles', name: 'profiles_list', arguments: {} }],
          finishReason: 'tool_calls',
        }
      }
      const toolMessage = request.messages.find(message => message.role === 'tool')
      expect(toolMessage?.content).not.toContain('base64')
      assetUrl = JSON.parse(toolMessage?.content || '{}').profiles[0].avatar.dataUrl
      expect(assetUrl).toMatch(/^file:\/\//)
      return { content: 'done', finishReason: 'stop' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, tools })
        .run({ messages: ['list profiles'], toolContext: { workspaceRoot } })
      expect(result.output.content).toBe('done')
      expect(fileURLToPath(assetUrl)).toContain(join(workspaceRoot, '.ekko-tmp', 'tool-assets'))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('projects old browser snapshots only in model requests and keeps full tool events and history', async () => {
    const tools = new AgentToolRegistry()
    let snapshotNumber = 0
    const toolName = 'ekko_studio_browser_toolset'
    tools.register({ definition: { name: toolName, parameters: { type: 'object' } }, async execute() {
      snapshotNumber++
      return { ok: true, content: JSON.stringify({ result: { tabId: 'tab', snapshotId: String(snapshotNumber),
        nodes: Array.from({ length: 100 }, (_, i) => ({ ref: `@e${i + 1}`, role: 'button', name: `Item ${i}` })) } }) }
    } })
    const client = modelClient((request, call) => {
      if (call <= 2) return { content: '', toolCalls: [{ id: `call-${call}`, name: toolName, arguments: {} }], finishReason: 'tool_calls' }
      const history = request.messages.filter(message => message.role === 'tool')
      expect(JSON.parse(history[0].content).result).toMatchObject({ stale: true, historicalNodeCount: 100 })
      expect(JSON.parse(history[1].content).result.nodes).toHaveLength(100)
      expect(history[1].content).not.toContain('\n')
      return { content: 'done', finishReason: 'stop' }
    })
    const events: AgentRuntimeEvent[] = []
    const result = await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['browse'], onEvent: event => events.push(event) })
    const completed = events.filter(event => event.type === 'tool.completed')
    expect(completed).toHaveLength(2)
    for (const event of completed) expect(JSON.parse((event as any).result.content).result.nodes).toHaveLength(100)
    for (const message of result.messages.filter(message => message.role === 'tool')) {
      expect(JSON.parse(message.content).result.nodes).toHaveLength(100)
    }
  })

  it.each(['browser_navigate', 'browser_click', 'mcp__other__snapshot', 'ekko_studio_api_request'])(
    'keeps snapshot-like history and default JSON formatting for %s', async toolName => {
      const tools = new AgentToolRegistry()
      const outputs: string[] = []
      tools.register({ definition: { name: toolName, parameters: { type: 'object' } }, async execute() {
        const result = { result: { tabId: 'tab', snapshotId: String(outputs.length),
          nodes: [{ ref: '@e1', role: 'button', name: 'Keep full evidence' }] } }
        outputs.push(JSON.stringify(result, null, 2))
        return { ok: true, content: JSON.stringify(result) }
      } })
      const client = modelClient((request, call) => {
        if (call <= 2) return { content: '', toolCalls: [{ id: `call-${call}`, name: toolName, arguments: {} }], finishReason: 'tool_calls' }
        expect(request.messages.filter(message => message.role === 'tool').map(message => message.content)).toEqual(outputs)
        return { content: 'done', finishReason: 'stop' }
      })
      await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['inspect'] })
      expect(outputs).toHaveLength(2)
    },
  )

  it('bounds oversized tool results before the next model request', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ekko-runtime-large-result-'))
    const largeContent = `head-${'x'.repeat(DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES)}-tail`
    const largeTool: AgentTool = {
      definition: {
        name: 'large_result',
        description: 'Return oversized text',
        parameters: { type: 'object' },
      },
      async execute() {
        return { ok: true, content: largeContent }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(largeTool)
    let artifactPath = ''
    const client = modelClient((request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_large', name: 'large_result', arguments: {} }],
          finishReason: 'tool_calls',
        }
      }
      const toolMessage = request.messages.find(message => message.role === 'tool')
      expect(Buffer.byteLength(toolMessage?.content || '')).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES + 1_000)
      expect(toolMessage?.content).toContain('tool result truncated')
      artifactPath = toolMessage?.content.match(/Full output saved to (.+?); inspect it/)?.[1] || ''
      return { content: 'done', finishReason: 'stop' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, tools })
        .run({ messages: ['run large tool'], toolContext: { workspaceRoot } })
      expect(result.output.content).toBe('done')
      expect(artifactPath).toContain(join(workspaceRoot, '.ekko-tmp', 'tool-assets'))
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe(largeContent)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('discovers and executes MCP tools from the run tool context', async () => {
    const client = modelClient((request, call) => {
      if (call === 1) {
        expect(request.tools?.some(tool => tool.name === 'fake_echo')).toBe(true)
        return {
          content: '',
          toolCalls: [{ id: 'call_mcp', name: 'fake_echo', arguments: { text: 'hello' } }],
          finishReason: 'tool_calls',
        }
      }
      return { content: 'done', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client })

    const result = await runtime.run({
      messages: ['use mcp'],
      toolContext: {
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')],
          },
        },
      },
    })

    expect(result.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'use mcp' },
      { role: 'assistant', toolCalls: [{ id: 'call_mcp', name: 'fake_echo' }] },
      { role: 'tool', toolCallId: 'call_mcp', name: 'fake_echo', content: 'mcp:hello' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('returns unknown tool failures as tool messages', async () => {
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [{ id: 'call_missing', name: 'missing_tool', arguments: {} }],
        }
      : { content: 'handled missing tool' })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry(), maxSteps: 2 })

    const result = await runtime.run({ messages: ['call missing'] })

    expect(result.messages[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_missing',
      name: 'missing_tool',
      content: 'Unknown tool: missing_tool',
    })
    expect(result.output.content).toBe('handled missing tool')
  })

  it('asks the model to correct or change approach after the same tool fails three times', async () => {
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      return call <= 6
        ? {
            content: '',
            toolCalls: [{ id: `call_missing_${call}`, name: 'missing_tool', arguments: {} }],
          }
        : { content: 'recovered with another approach', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      toolFailureRecoveryThreshold: 3,
      maxIdenticalToolFailures: 999,
      maxSteps: 10,
    })
    const events: AgentRuntimeEvent[] = []

    const result = await runtime.run({
      messages: ['call missing repeatedly'],
      onEvent: event => events.push(event),
    })

    expect(result.output).toMatchObject({
      content: 'recovered with another approach',
      finishReason: 'stop',
    })
    expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(6)
    expect(client.create).toHaveBeenCalledTimes(7)
    expect(events.filter(event => event.type === 'run.tool_recovery_required')).toHaveLength(2)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run.tool_recovery_required',
      toolName: 'missing_tool',
      failures: 3,
    }))
    expect(requests[3].messages).toContainEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('correct the arguments or prerequisites, or switch to a different tool or approach'),
    }))
    expect(requests[6].messages.filter(message => (
      message.role === 'system' && message.content.includes('Tool recovery required: "missing_tool"')
    ))).toHaveLength(2)
  })

  it('terminates the run after maxIdenticalToolFailures identical-argument failures', async () => {
    const client = modelClient((_request, call) => call <= 3
      ? {
          content: '',
          toolCalls: [{ id: `call_identical_${call}`, name: 'missing_tool', arguments: {} }],
        }
      : { content: 'should not reach here', finishReason: 'stop' })
    const events: AgentRuntimeEvent[] = []
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      toolFailureRecoveryThreshold: 3,
      maxIdenticalToolFailures: 3,
      maxSteps: 10,
    })

    const result = await runtime.run({
      messages: ['call missing with same args'],
      onEvent: event => events.push(event),
    })

    expect(result.output).toMatchObject({
      finishReason: 'identical_tool_failure_limit',
      content: expect.stringContaining('Stopped after 3 consecutive identical-argument failures'),
    })
    expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(3)
    expect(client.create).toHaveBeenCalledTimes(3)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'run.identical_tool_failure_limit',
      toolName: 'missing_tool',
      failures: 3,
      limit: 3,
    }))
  })

  it('does not combine failures from different tools into one recovery streak', async () => {
    const names = ['missing_a', 'missing_b', 'missing_a', 'missing_b']
    const client = modelClient((_request, call) => call <= names.length
      ? {
          content: '',
          toolCalls: [{ id: `missing-${call}`, name: names[call - 1], arguments: {} }],
        }
      : { content: 'done', finishReason: 'stop' })
    const events: string[] = []

    const result = await new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      toolFailureRecoveryThreshold: 3,
      maxSteps: 10,
    }).run({
      messages: ['try alternatives'],
      onEvent: event => events.push(event.type),
    })

    expect(result.output.content).toBe('done')
    expect(events).not.toContain('run.tool_recovery_required')
  })

  it('passes abort signals into model requests', async () => {
    const controller = new AbortController()
    const client = modelClient((request) => {
      expect(request.signal).toBe(controller.signal)
      return { content: 'done' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    const result = await runtime.run({ messages: ['hi'], signal: controller.signal })

    expect(result.output.content).toBe('done')
  })

  it('stops before a model request when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = modelClient(() => ({ content: 'should not run' }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })

    await expect(runtime.run({ messages: ['hi'], signal: controller.signal })).rejects.toThrow('Run aborted.')
    expect(client.create).not.toHaveBeenCalled()
  })

  it('interrupts a matching model request as a graceful boundary completion', async () => {
    let signalModelStarted!: (signal: AbortSignal | undefined) => void
    const modelStarted = new Promise<AbortSignal | undefined>((resolve) => {
      signalModelStarted = resolve
    })
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(request => new Promise<ModelResponse>((_resolve, reject) => {
        signalModelStarted(request.signal)
        const rejectAborted = () => {
          const error = new Error('Run aborted.')
          error.name = 'AbortError'
          reject(error)
        }
        request.signal?.addEventListener('abort', rejectAborted, { once: true })
        if (request.signal?.aborted) rejectAborted()
      })),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const eventTypes: string[] = []
    let runId = ''
    const run = runtime.run({
      messages: ['hi'],
      metadata: { session_id: 'session-1' },
      onEvent: event => {
        eventTypes.push(event.type)
        if (event.type === 'run.started') runId = event.runId
      },
    })

    const modelSignal = await modelStarted
    expect(modelSignal).toBeInstanceOf(AbortSignal)
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-1',
      expectedRunId: runId,
    })).toEqual({ status: 'accepted', runId, phase: 'model' })
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-1',
      expectedRunId: runId,
    })).toEqual({ status: 'already_pending', runId, phase: 'model' })
    expect(modelSignal?.aborted).toBe(true)

    const result = await run

    expect(result.output).toMatchObject({ content: '', finishReason: 'boundary_interrupt' })
    expect(result.steps).toEqual([])
    expect(eventTypes).toContain('run.completed')
    expect(eventTypes).not.toContain('run.failed')
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-1',
      expectedRunId: runId,
    })).toEqual({ status: 'not_running' })
  })

  it('finishes the whole tool batch before honoring repeated boundary interrupts', async () => {
    let releaseFirstTool!: () => void
    let signalFirstToolStarted!: () => void
    const firstToolStarted = new Promise<void>((resolve) => {
      signalFirstToolStarted = resolve
    })
    const firstToolRelease = new Promise<void>((resolve) => {
      releaseFirstTool = resolve
    })
    const toolOrder: string[] = []
    const tools = new AgentToolRegistry()
    tools.register({
      definition: { name: 'first', description: 'first tool', parameters: { type: 'object' } },
      async execute() {
        toolOrder.push('first:start')
        signalFirstToolStarted()
        await firstToolRelease
        toolOrder.push('first:end')
        return { ok: true, content: 'first result' }
      },
    })
    tools.register({
      definition: { name: 'second', description: 'second tool', parameters: { type: 'object' } },
      async execute() {
        toolOrder.push('second')
        return { ok: true, content: 'second result' }
      },
    })
    const client = modelClient((_request, call) => call === 1
      ? {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'first', arguments: {} },
            { id: 'call-2', name: 'second', arguments: {} },
          ],
          finishReason: 'tool_calls',
        }
      : { content: 'must not request another model step' })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    let runId = ''
    const run = runtime.run({
      messages: ['use tools'],
      metadata: { session_id: 'session-2' },
      onEvent: event => {
        if (event.type === 'run.started') runId = event.runId
      },
    })

    await firstToolStarted
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-2',
      expectedRunId: runId,
    })).toEqual({ status: 'accepted', runId, phase: 'tool_batch' })
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-2',
      expectedRunId: runId,
    })).toEqual({ status: 'already_pending', runId, phase: 'tool_batch' })
    releaseFirstTool()

    const result = await run

    expect(toolOrder).toEqual(['first:start', 'first:end', 'second'])
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(result.output.finishReason).toBe('boundary_interrupt')
    expect(result.steps.map(step => step.type)).toEqual(['model', 'tool', 'tool'])
    expect(result.messages.filter(message => message.role === 'tool')).toMatchObject([
      { toolCallId: 'call-1', content: 'first result' },
      { toolCallId: 'call-2', content: 'second result' },
    ])
  })

  it('does not interrupt a newer or mismatched run', async () => {
    let releaseModel!: () => void
    let signalModelStarted!: () => void
    const modelStarted = new Promise<void>((resolve) => {
      signalModelStarted = resolve
    })
    const modelRelease = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    const client = modelClient(async () => {
      signalModelStarted()
      await modelRelease
      return { content: 'done' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const run = runtime.run({
      messages: ['hi'],
      metadata: { session_id: 'session-3' },
    })

    await modelStarted
    expect(runtime.requestBoundaryInterrupt({
      sessionId: 'session-3',
      expectedRunId: 'stale-run-id',
    })).toEqual({ status: 'run_mismatch' })
    releaseModel()

    await expect(run).resolves.toMatchObject({
      output: { content: 'done' },
    })
  })

  it('defaults maxSteps to 90', async () => {
    const client = modelClient(() => ({ content: 'done' }))
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const seen: number[] = []

    await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'run.started') seen.push(event.maxSteps)
      },
    })

    expect(DEFAULT_AGENT_MAX_STEPS).toBe(90)
    expect(seen).toEqual([90])
  })

  it('retries each model step before continuing the loop', async () => {
    const client = modelClient((_request, call) => {
      if (call < 3) throw new Error(`temporary failure ${call}`)
      return { content: 'recovered' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const retries: number[] = []

    const result = await runtime.run({
      messages: ['hi'],
      onEvent: event => {
        if (event.type === 'model.retry') retries.push(event.retry)
      },
    })

    expect(result.output.content).toBe('recovered')
    expect(client.create).toHaveBeenCalledTimes(3)
    expect(retries).toEqual([1, 2])
  })

  it('stops the run after three failed model retries', async () => {
    const client = modelClient(() => {
      throw new Error('still failing')
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []

    await expect(runtime.run({
      messages: ['hi'],
      onEvent: event => events.push(event.type),
    })).rejects.toThrow('still failing')

    expect(DEFAULT_AGENT_MODEL_MAX_RETRIES).toBe(3)
    expect(client.create).toHaveBeenCalledTimes(4)
    expect(events.filter(event => event === 'model.retry')).toHaveLength(3)
    expect(events.at(-1)).toBe('run.failed')
  })

  it('does not retry a model provider error explicitly marked non-retryable', async () => {
    const client = modelClient(() => {
      throw new ModelProviderError('Not Found', {
        provider: 'glm',
        statusCode: 404,
        retryable: false,
      })
    })
    const runtime = new AgentRuntime({ modelClient: client, tools: new AgentToolRegistry() })
    const events: string[] = []

    await expect(runtime.run({
      messages: ['hi'],
      onEvent: event => events.push(event.type),
    })).rejects.toThrow('Not Found')

    expect(client.create).toHaveBeenCalledTimes(1)
    expect(events).not.toContain('model.retry')
    expect(events.at(-1)).toBe('run.failed')
  })

  it('keeps the run alive when view_image cannot be consumed by a text-only model', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ekko-runtime-text-only-image-'))
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(join(workspaceRoot, 'screenshot.png'), image)
    const tools = new AgentToolRegistry()
    tools.register(new ViewImageTool())
    const client = modelClient((request, call) => {
      if (call === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'view-image-call', name: 'view_image', arguments: { path: 'screenshot.png' } }],
          finishReason: 'tool_calls',
        }
      }
      const toolMessage = request.messages.find(message => message.toolCallId === 'view-image-call')
      expect(toolMessage?.content).toContain('does not support vision input')
      expect(toolMessage?.contentParts).toBeUndefined()
      return { content: 'The current model cannot inspect the screenshot.', finishReason: 'stop' }
    })
    const runtime = new AgentRuntime({ modelClient: client, tools })
    const events: any[] = []

    try {
      const result = await runtime.run({
        messages: ['Inspect the screenshot'],
        model: 'glm-5.3',
        toolContext: { workspaceRoot },
        onEvent: event => events.push(event),
      })

      expect(result.output.content).toBe('The current model cannot inspect the screenshot.')
      expect(result.steps.find(step => step.type === 'tool')).toMatchObject({
        type: 'tool',
        toolName: 'view_image',
        result: {
          ok: false,
          data: { code: 'VISION_UNSUPPORTED' },
        },
      })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool.failed', toolName: 'view_image' }),
        expect.objectContaining({ type: 'run.completed' }),
      ]))
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'run.failed' }),
      ]))
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('builds a system prompt from runtime context and user system messages without skill instructions', async () => {
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools: new AgentToolRegistry(),
      systemPrompt: 'Base prompt.',
      runtimeInstructions: ['Use tools carefully.'],
      skills: [{
        id: 'review',
        name: 'Review',
        instructions: 'Review for correctness.',
      }],
    })

    await runtime.run({
      messages: [
        { role: 'system', content: 'User system.' },
        { role: 'user', content: 'Go' },
      ],
      model: 'test-model',
    })

    expect(requests[0].messages[0].content).toContain('Base prompt.')
    expect(requests[0].messages[0].content).toContain('Use tools carefully.')
    expect(requests[0].messages[0].content).not.toContain('Review for correctness.')
    expect(requests[0].messages[0].content).not.toContain('## Skills')
    expect(requests[0].messages[0].content).toContain('User system.')
    expect(requests[0].messages[0].content).toContain('## Runtime Context\nprovider: test\nmodel: test-model')
    expect(requests[0].messages.filter(message => message.role === 'system')).toHaveLength(1)
  })

  it('does not inject skill instructions when all tools are disabled', async () => {
    const listTools = vi.fn(async () => [])
    const tools = new AgentToolRegistry()
    tools.registerProvider({ id: 'dynamic', listTools })
    const client = modelClient((request) => {
      expect(request.tools).toBeUndefined()
      expect(request.messages[0].content).not.toContain('Keep this skill instruction.')
      return { content: 'ok' }
    })

    await new AgentRuntime({
      modelClient: client,
      tools,
      toolsEnabled: false,
      skills: [{
        id: 'kept-skill',
        name: 'Kept Skill',
        instructions: 'Keep this skill instruction.',
      }],
    }).run({ messages: ['hi'] })

    expect(listTools).not.toHaveBeenCalled()
  })

  it('injects the skill discovery constraint when both skill tools are available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skills-'))
    const skillDirectory = join(root, 'skills')
    await mkdir(join(skillDirectory, 'weather'), { recursive: true })
    await writeFile(join(skillDirectory, 'weather', 'SKILL.md'), [
      '---',
      'name: weather',
      'description: INTERNAL DESCRIPTION MUST STAY HIDDEN.',
      'metadata:',
      '  keywords:',
      '    - meteorological lookup',
      '---',
      '# Weather',
      'Internal instructions.',
      '',
    ].join('\n'))
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['skill_list', 'skill_view', 'skill_manage']))
      expect(request.messages[0].content).toContain('## Available Skill Names\nweather')
      expect(request.messages[0].content).not.toContain('INTERNAL DESCRIPTION MUST STAY HIDDEN')
      expect(request.messages[0].content).not.toContain('meteorological lookup')
      expect(request.messages[0].content).toContain('## Skill Discovery')
      expect(request.messages[0].content).toContain('call skill_view directly with that exact name')
      expect(request.messages[0].content).toContain('Use skill_list only as a fallback')
      expect(request.messages[0].content).toContain('## Skill Evolution')
      return { content: 'ok' }
    })

    try {
      await new AgentRuntime({ modelClient: client, skillDirectory }).run({ messages: ['hi'] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hard-loads keyword-matched skills through a visible skill_view before the model responds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-match-'))
    const skillDirectory = join(root, 'skills')
    await mkdir(join(skillDirectory, 'release-notes'), { recursive: true })
    await writeFile(join(skillDirectory, 'release-notes', 'SKILL.md'), [
      '---',
      'name: release-notes',
      'description: Write polished summaries.',
      'metadata:',
      '  keywords:',
      '    - release summary',
      '---',
      '# Release Notes',
      'Keep the summary user-facing.',
      '',
    ].join('\n'))
    const requests: ModelRequest[] = []
    const eventTypes: string[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })

    let result: Awaited<ReturnType<AgentRuntime['run']>>
    try {
      result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [{ role: 'user', content: 'Host-wrapped current request.' }],
        memoryInput: {
          messages: [{ role: 'user', content: 'Please write a release summary for this version.' }],
        },
        onEvent: event => eventTypes.push(event.type),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    expect(requests).toHaveLength(1)
    expect(requests[0].messages.slice(0, 4).map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    const skillResult = requests[0].messages.find(message => message.role === 'tool' && message.name === 'skill_view')
    expect(skillResult?.content).toContain('[skill_view] name=release-notes')
    expect(skillResult?.content).toContain('Keep the summary user-facing.')
    expect(result!.steps.slice(0, 2).map(step => [step.type, step.step])).toEqual([
      ['model', 0],
      ['tool', 0],
    ])
    expect(eventTypes.indexOf('tool.started')).toBeLessThan(eventTypes.indexOf('model.started'))
    expect(eventTypes).toContain('tool.completed')
  })

  it('reuses a complete matching skill_view already present in the effective context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-reuse-'))
    const skillDirectory = join(root, 'skills')
    const skillContent = [
      '---',
      'name: release-notes',
      'description: Write polished summaries.',
      'metadata:',
      '  keywords:',
      '    - release summary',
      '---',
      '# Release Notes',
      'Keep the summary user-facing.',
      '',
    ].join('\n')
    await mkdir(join(skillDirectory, 'release-notes'), { recursive: true })
    await writeFile(join(skillDirectory, 'release-notes', 'SKILL.md'), skillContent)
    const priorResult = [
      `[skill_view] name=release-notes (${skillContent.length} chars) file=SKILL.md sha256=${skillContentHash(skillContent)} baseDirectory=${join(skillDirectory, 'release-notes')}`,
      skillContent,
    ].join('\n')
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })

    let result: Awaited<ReturnType<AgentRuntime['run']>>
    try {
      result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'prior-skill-view', name: 'skill_view', arguments: { name: 'release-notes' } }],
          },
          { role: 'tool', name: 'skill_view', toolCallId: 'prior-skill-view', content: priorResult },
          { role: 'user', content: 'Please update the release summary.' },
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    expect(requests).toHaveLength(1)
    expect(requests[0].messages.filter(message => message.role === 'tool' && message.name === 'skill_view'))
      .toHaveLength(1)
    expect(result!.steps.some(step => step.type === 'tool' && step.step === 0)).toBe(false)
  })

  it('replaces a truncated matching skill_view instead of stacking another copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-reload-'))
    const skillDirectory = join(root, 'skills')
    const skillContent = [
      '---',
      'name: release-notes',
      'description: Write polished summaries.',
      'metadata:',
      '  keywords:',
      '    - release summary',
      '---',
      '# Release Notes',
      'Keep the summary user-facing and include every relevant change.',
      '',
    ].join('\n')
    await mkdir(join(skillDirectory, 'release-notes'), { recursive: true })
    await writeFile(join(skillDirectory, 'release-notes', 'SKILL.md'), skillContent)
    const truncatedResult = [
      `[skill_view] name=release-notes (${skillContent.length} chars) file=SKILL.md sha256=${skillContentHash(skillContent)} baseDirectory=${join(skillDirectory, 'release-notes')}`,
      skillContent.slice(0, 36),
      '... [truncated]',
      skillContent.slice(-20),
    ].join('\n')
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })

    let result: Awaited<ReturnType<AgentRuntime['run']>>
    try {
      result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'truncated-skill-view', name: 'skill_view', arguments: { name: 'release-notes' } }],
          },
          { role: 'tool', name: 'skill_view', toolCallId: 'truncated-skill-view', content: truncatedResult },
          { role: 'user', content: 'Please update the release summary.' },
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const visibleSkillResults = requests[0].messages.filter(message => (
      message.role === 'tool' && message.name === 'skill_view'
    ))
    expect(visibleSkillResults).toHaveLength(1)
    expect(visibleSkillResults[0].content).toContain(skillContent)
    expect(visibleSkillResults[0].content).not.toContain('... [truncated]')
    expect(result!.steps.some(step => step.type === 'tool' && step.step === 0)).toBe(true)
  })

  it('reloads a same-length historical skill_view when its content hash is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-hash-reload-'))
    const skillDirectory = join(root, 'skills')
    const currentContent = [
      '---',
      'name: release-notes',
      'description: Write polished summaries.',
      'metadata:',
      '  keywords:',
      '    - release summary',
      '---',
      '# Release Notes',
      'Keep every summary user-facing.',
      '',
    ].join('\n')
    const staleContent = currentContent.replace('every', 'other')
    expect(staleContent).toHaveLength(currentContent.length)
    await mkdir(join(skillDirectory, 'release-notes'), { recursive: true })
    await writeFile(join(skillDirectory, 'release-notes', 'SKILL.md'), currentContent)
    const priorResult = [
      `[skill_view] name=release-notes (${staleContent.length} chars) file=SKILL.md sha256=${skillContentHash(staleContent)} baseDirectory=${join(skillDirectory, 'release-notes')}`,
      staleContent,
    ].join('\n')
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })

    let result: Awaited<ReturnType<AgentRuntime['run']>>
    try {
      result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [
          {
            role: 'assistant', content: '',
            toolCalls: [{ id: 'stale-skill-view', name: 'skill_view', arguments: { name: 'release-notes' } }],
          },
          { role: 'tool', name: 'skill_view', toolCallId: 'stale-skill-view', content: priorResult },
          { role: 'user', content: 'Please update the release summary.' },
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const retained = requests[0].messages.filter(message => (
      message.role === 'tool' && message.name === 'skill_view'
    ))
    expect(retained).toHaveLength(1)
    expect(retained[0].content).toContain(currentContent)
    expect(retained[0].content).not.toContain(staleContent)
    expect(result!.steps.some(step => step.type === 'tool' && step.step === 0)).toBe(true)
  })

  it('keeps only the latest cropped skill_view after the request moves to another task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-history-dedupe-'))
    const skillDirectory = join(root, 'skills')
    const skillContent = [
      '---',
      'name: release-notes',
      'description: Write polished summaries.',
      'metadata:',
      '  keywords:',
      '    - release summary',
      '---',
      '# Release Notes',
      'Keep the summary user-facing.',
      '',
    ].join('\n')
    await mkdir(join(skillDirectory, 'release-notes'), { recursive: true })
    await writeFile(join(skillDirectory, 'release-notes', 'SKILL.md'), skillContent)
    const cropped = (label: string) => [
      `[skill_view] name=release-notes (${skillContent.length} chars) file=SKILL.md sha256=${skillContentHash(skillContent)} baseDirectory=${join(skillDirectory, 'release-notes')}`,
      `${label}: ${skillContent.slice(0, 24)}`,
      '... [truncated]',
    ].join('\n')
    const requests: ModelRequest[] = []
    const client = modelClient((request) => {
      requests.push(request)
      return { content: 'ok' }
    })

    try {
      await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [
          {
            role: 'assistant', content: '',
            toolCalls: [{ id: 'old-skill-view', name: 'skill_view', arguments: { name: 'release-notes' } }],
          },
          { role: 'tool', name: 'skill_view', toolCallId: 'old-skill-view', content: cropped('old') },
          {
            role: 'assistant', content: '',
            toolCalls: [{ id: 'latest-skill-view', name: 'skill_view', arguments: { name: 'release-notes' } }],
          },
          { role: 'tool', name: 'skill_view', toolCallId: 'latest-skill-view', content: cropped('latest') },
          { role: 'user', content: 'Thanks, that task is complete. Tell me a short joke.' },
        ],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const retained = requests[0].messages.filter(message => (
      message.role === 'tool' && message.name === 'skill_view'
    ))
    expect(retained).toHaveLength(1)
    expect(retained[0].content).toContain('latest:')
  })

  it('lets the main model map a non-English request to an injected skill name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-multilingual-skill-'))
    const skillDirectory = join(root, 'skills')
    await mkdir(join(skillDirectory, 'weather'), { recursive: true })
    await writeFile(join(skillDirectory, 'weather', 'SKILL.md'), [
      '---',
      'name: weather',
      'description: Fetch current conditions.',
      'metadata:',
      '  keywords:',
      '    - weather forecast',
      '---',
      '# Weather',
      'Fetch live weather data.',
      '',
    ].join('\n'))
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        expect(request.messages[0].content).toContain('## Available Skill Names\nweather')
        expect(request.messages.some(message => message.role === 'tool')).toBe(false)
        return {
          toolCalls: [{ id: 'skill-weather', name: 'skill_view', arguments: { name: 'weather' } }],
        }
      }
      expect(request.messages.find(message => message.role === 'tool' && message.name === 'skill_view')?.content)
        .toContain('Fetch live weather data.')
      return { content: '已加载天气技能。' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [{ role: 'user', content: '帮我查一下今天上海会不会下雨' }],
      })
      expect(result.output.content).toBe('已加载天气技能。')
      expect(result.steps.some(step => step.type === 'tool' && step.toolName === 'skill_view')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    expect(requests).toHaveLength(2)
  })

  it('surfaces post-install Skill validation in the terminal tool result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-skill-validation-'))
    const skillDirectory = join(root, 'skills')
    await mkdir(skillDirectory, { recursive: true })
    const skillPath = join(skillDirectory, 'dashi-ppt', 'SKILL.md')
    const skillContent = [
      '---',
      'name: dashi-ppt',
      'description: Create presentation decks.',
      '---',
      '# Dashi PPT',
      'Create a deck.',
      '',
    ].join('\n')
    const installerPath = join(root, 'install-skill.cjs')
    await writeFile(installerPath, [
      "const { mkdirSync, writeFileSync } = require('node:fs')",
      "const { dirname } = require('node:path')",
      `const skillPath = ${JSON.stringify(skillPath)}`,
      `const skillContent = ${JSON.stringify(skillContent)}`,
      'mkdirSync(dirname(skillPath), { recursive: true })',
      'writeFileSync(skillPath, skillContent)',
      'process.stdout.write("installed")',
    ].join('\n'))
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      if (call === 1) {
        return {
          toolCalls: [{
            id: 'install-skill',
            name: 'terminal_exec',
            arguments: {
              command: process.execPath,
              args: [installerPath],
            },
          }],
        }
      }
      const terminalResult = request.messages.find(message => message.role === 'tool' && message.name === 'terminal_exec')
      expect(terminalResult?.content).toContain('installed')
      expect(terminalResult?.content).toContain('[skill_validation]')
      expect(terminalResult?.content).toContain('dashi-ppt (needs_metadata)')
      expect(terminalResult?.content).toContain('Call skill_view')
      return { content: 'repair required' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [{ role: 'user', content: 'Install the requested package.' }],
        toolContext: { workspaceRoot: root },
      })
      expect(result.output.content).toBe('repair required')
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    expect(requests).toHaveLength(2)
  })

  it('does not scan existing Skill metadata after an unrelated terminal command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-runtime-unrelated-terminal-'))
    const skillDirectory = join(root, 'skills')
    await mkdir(join(skillDirectory, 'missing-keywords'), { recursive: true })
    await writeFile(join(skillDirectory, 'missing-keywords', 'SKILL.md'), [
      '---',
      'name: missing-keywords',
      'description: Existing invalid metadata.',
      '---',
      '# Existing Skill',
      'Instructions.',
      '',
    ].join('\n'))
    const client = modelClient((request, call) => {
      if (call === 1) {
        return {
          toolCalls: [{
            id: 'unrelated-command',
            name: 'terminal_exec',
            arguments: {
              command: process.execPath,
              args: ['-e', 'process.stdout.write("unrelated")'],
            },
          }],
        }
      }
      const terminalResult = request.messages.find(message => message.role === 'tool' && message.name === 'terminal_exec')
      expect(terminalResult?.content).toBe('unrelated')
      expect(terminalResult?.content).not.toContain('[skill_validation]')
      return { content: 'done' }
    })

    try {
      const result = await new AgentRuntime({ modelClient: client, skillDirectory }).run({
        messages: [{ role: 'user', content: 'Run an unrelated command.' }],
        toolContext: { workspaceRoot: root },
      })
      expect(result.output.content).toBe('done')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reviews a tool-heavy turn in the background with only skill tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-skill-review-'))
    const skillDirectory = join(root, 'skills')
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, 'input.txt'), 'reusable evidence')
    let mainCalls = 0
    let reviewCalls = 0
    const reviewRequests: ModelRequest[] = []
    const usageEvents: unknown[] = []
    const eventTypes: string[] = []
    const client: ModelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      create: vi.fn(async (request: ModelRequest) => {
        if (request.metadata?.purpose === 'ekko-skill-review') {
          reviewRequests.push(request)
          reviewCalls += 1
          if (reviewCalls === 1) {
            return {
              content: '',
              toolCalls: [{ id: 'review-list', name: 'skill_list', arguments: {} }],
              finishReason: 'tool_calls',
            }
          }
          if (reviewCalls === 2) {
            return {
              content: '',
              toolCalls: [{
                id: 'review-create',
                name: 'skill_manage',
                arguments: {
                  action: 'create',
                  name: 'reusable-verification',
                  content: [
                    '---',
                    'name: reusable-verification',
                    'description: Verify recurring changes consistently.',
                    'metadata:',
                    '  keywords:',
                    '    - reusable verification',
                    '---',
                    '# Reusable Verification',
                    '## Procedure',
                    'Run the focused check and verify its output.',
                    '',
                  ].join('\n'),
                },
              }],
              finishReason: 'tool_calls',
              usage: { inputTokens: 20, outputTokens: 5 },
            }
          }
          return { content: 'Done.', usage: { inputTokens: 12, outputTokens: 2 } }
        }
        mainCalls += 1
        return mainCalls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'main-read', name: 'read_file', arguments: { path: 'input.txt' } }],
              finishReason: 'tool_calls',
            }
          : { content: 'Main answer.' }
      }),
      stream: vi.fn(),
    }
    const runtime = new AgentRuntime({
      modelClient: client,
      skillDirectory,
      skillReviewEveryToolCalls: 1,
    })

    try {
      const result = await runtime.run({
        messages: ['Use the input and finish the task.'],
        metadata: { session_id: 'review-session' },
        toolContext: { workspaceRoot },
        onSkillReviewUsage: event => {
          usageEvents.push(event)
          throw new Error('observer failure')
        },
        onEvent: event => eventTypes.push(event.type),
      })
      expect(result.output.content).toBe('Main answer.')

      await runtime.drainSkillReviews()

      expect(reviewRequests[0].tools?.map(tool => tool.name).sort()).toEqual([
        'skill_list',
        'skill_manage',
        'skill_view',
      ])
      expect(reviewRequests[0].messages[0].content).toContain('background procedural-learning reviewer')
      expect(reviewRequests[0].messages[1].content).toContain('reusable evidence')
      await expect(readFile(
        join(skillDirectory, 'reusable-verification', 'SKILL.md'),
        'utf8',
      )).resolves.toContain('Run the focused check')
      expect(usageEvents).toHaveLength(2)
      expect(eventTypes.indexOf('run.completed')).toBeLessThan(eventTypes.indexOf('skill.review.started'))
      expect(eventTypes).toContain('skill.review.completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disables constructor and per-run skills without disabling regular tools', async () => {
    const regularTool: AgentTool = {
      definition: { name: 'regular_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'regular' }
      },
    }
    const skillTool: AgentTool = {
      definition: { name: 'skill_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'skill' }
      },
    }
    const tools = new AgentToolRegistry()
    tools.register(regularTool)
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toEqual(['regular_tool'])
      expect(request.messages[0].content).not.toContain('Disabled constructor skill.')
      expect(request.messages[0].content).not.toContain('Disabled run skill.')
      return { content: 'ok' }
    })
    const runtime = new AgentRuntime({
      modelClient: client,
      tools,
      skillsEnabled: false,
      skills: [{
        id: 'constructor-skill',
        name: 'Constructor Skill',
        instructions: 'Disabled constructor skill.',
        tools: [skillTool],
      }],
    })

    runtime.registerSkill({
      id: 'registered-skill',
      name: 'Registered Skill',
      instructions: 'Disabled registered skill.',
      tools: [skillTool],
    })
    await runtime.run({
      messages: ['hi'],
      skills: [{
        id: 'run-skill',
        name: 'Run Skill',
        instructions: 'Disabled run skill.',
        tools: [skillTool],
      }],
    })
  })

  it('refreshes dynamic tool providers before running', async () => {
    const providerTool: AgentTool = {
      definition: { name: 'provided_tool', parameters: { type: 'object' } },
      async execute() {
        return { ok: true, content: 'provided' }
      },
    }
    const provider: AgentToolProvider = {
      id: 'test-provider',
      async listTools() {
        return [providerTool]
      },
    }
    const tools = new AgentToolRegistry()
    tools.registerProvider(provider)
    const client = modelClient((request) => {
      expect(request.tools?.map(tool => tool.name)).toContain('provided_tool')
      return { content: 'ok' }
    })

    await new AgentRuntime({ modelClient: client, tools }).run({ messages: ['hi'] })
  })

  it('stores model context by session and sends it on follow-up runs', async () => {
    const requests: ModelRequest[] = []
    const client = modelClient((request, call) => {
      requests.push(request)
      return {
        content: `ok-${call}`,
        context: { responseId: `resp-${call}` },
      }
    })
    const runtime = new AgentRuntime({ modelClient: client })

    const first = await runtime.run({
      messages: ['first'],
      metadata: { session_id: 'session-a' },
    })
    const second = await runtime.run({
      messages: ['second'],
      metadata: { session_id: 'session-a' },
    })
    await runtime.run({
      messages: ['other'],
      metadata: { session_id: 'session-b' },
    })

    expect(first.context).toEqual({ responseId: 'resp-1' })
    expect(second.context).toEqual({ responseId: 'resp-2' })
    expect(requests[0].context).toBeUndefined()
    expect(requests[1].context).toEqual({ responseId: 'resp-1' })
    expect(requests[2].context).toBeUndefined()
  })

  it('buildSystemPrompt omits structured tool descriptions', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
    })

    expect(prompt).toContain('Base')
    expect(prompt).not.toContain('Available Tools')
    expect(prompt).not.toContain('read_file')
  })

  it('buildSystemPrompt includes provider, model, and profile in runtime context', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
      context: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        profile: 'work',
        workspaceRoot: '/tmp/workspace',
      },
    })

    expect(prompt).toContain([
      '## Runtime Context',
      'provider: openrouter',
      'model: anthropic/claude-sonnet-4',
      'profile: work',
      'workspaceRoot: /tmp/workspace',
    ].join('\n'))
  })

  it('buildSystemPrompt adds the on-demand skill discovery constraint', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
      skillDiscoveryEnabled: true,
      skillManagementEnabled: true,
      skillNames: ['weather', 'pdf'],
    })

    expect(prompt).toContain('## Available Skill Names\npdf, weather')
    expect(prompt).toContain('## Skill Discovery')
    expect(prompt).toContain('call skill_view directly with that exact name')
    expect(prompt).toContain('Use skill_list only as a fallback')
    expect(prompt).toContain('## Skill Evolution')
    expect(prompt).toContain('Prefer a small patch over a full edit.')
    expect(prompt).not.toContain('## Skills')
  })

  it('buildSystemPrompt always includes Ekko image and file output guidance', () => {
    const prompt = buildSystemPrompt({ basePrompt: 'Base' })

    expect(prompt).toContain('## Image and File Output')
    expect(prompt).toContain('![description](/absolute/path/image.png)')
    expect(prompt).toContain('![description](<C:/absolute/path/image.png>)')
    expect(prompt).toContain('Do not use relative paths or `file://` URLs.')
  })

  it('buildSystemPrompt requires dependency preflight before tool execution', () => {
    const prompt = buildSystemPrompt({ basePrompt: 'Base' })

    expect(prompt).toContain('## Tool Execution')
    expect(prompt).toContain('prerequisites named by a Skill as requirements, not proof that they are installed')
    expect(prompt).toContain('perform a lightweight availability check')
    expect(prompt).toContain('Request independent tool calls together in one response')
    expect(prompt).toContain('complete standalone sentence')
    expect(prompt).toContain('Do not end tool-call preambles with ":" or "："')
    expect(prompt).toContain('use code_exec, including for one-line snippets')
    expect(prompt).toContain('Do not probe Node or Python with terminal_exec first')
    expect(prompt).toContain('Use terminal_exec for CLI commands')
    expect(prompt).toContain('platform-appropriate package-manager forms')
    expect(prompt).toContain("workspace's .ekko-tmp directory")
    expect(prompt).toContain('After terminal_exec reports a [skill_validation] issue')
    expect(prompt).toContain('do not retry the operation through another tool or language runtime')
    expect(prompt).toContain('prefer a compatible installed or built-in alternative')
  })

  it('buildSystemPrompt injects Windows-native command rules on Windows', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Base',
      context: { platform: 'win32', arch: 'x64' },
    })

    expect(prompt).toContain('## Command Environment')
    expect(prompt).toContain('Host platform: Windows (x64)')
    expect(prompt).toContain('Do not use Unix-only commands or paths')
    expect(prompt).toContain('command=cmd.exe')
    expect(prompt).toContain('Windows .cmd and .bat launchers')
    expect(prompt).toContain('Use where.exe')
    expect(prompt).toContain('Do not use which')
    expect(prompt).toContain('Do not invent drive letters or assume WSL is installed')
  })

  it('buildSystemPrompt injects macOS and Linux command rules independently', () => {
    const macPrompt = buildSystemPrompt({
      basePrompt: 'Base',
      context: { platform: 'darwin', arch: 'arm64' },
    })
    const linuxPrompt = buildSystemPrompt({
      basePrompt: 'Base',
      context: { platform: 'linux', arch: 'x64' },
    })

    expect(macPrompt).toContain('Host platform: macOS (arm64)')
    expect(macPrompt).toContain('BSD variants')
    expect(macPrompt).toContain('Invoke sh or zsh explicitly')
    expect(linuxPrompt).toContain('Host platform: Linux (x64)')
    expect(linuxPrompt).toContain('Invoke sh or bash explicitly')
  })
})
