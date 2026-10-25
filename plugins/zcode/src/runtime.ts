import { randomUUID } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { AgentEventQueue, NativeRpcConnection, acpCommandCatalog } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, readAgentImages, type AgentContextConfiguration, type AgentOutputEvent, type AgentRunHandle,
  type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type ModelGatewayHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { prepareZcode } from './configuration'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
interface Checkpoint { nativeSessionId: string }
const validCheckpoint = (value: any): value is Checkpoint => value && Object.keys(value).length === 1 && typeof value.nativeSessionId === 'string' && /^sess_[A-Za-z0-9._-]{1,192}$/.test(value.nativeSessionId)
async function sameWorkspace(value: unknown, expected: string): Promise<boolean> {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) return false
  try { return await realpath(value) === expected } catch { return false }
}

export function createZcodeRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config, cwd = String(config.cwd), mode = input.mode, scoped = mode === 'scoped'
  if (!isAbsolute(cwd) || !runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode requires an absolute workspace and host-managed auxiliary storage')
  if (input.resume && !validCheckpoint(input.resume)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode checkpoint')
  const commands = acpCommandCatalog(runtime, { pluginId: 'studio.agent-zcode', agentTypeId: 'zcode', name: 'ZCode' })
  let checkpoint = input.resume as unknown as Checkpoint | undefined, current: AgentRunHandle | undefined, disposed = false, unavailable = false
  return {
    async run(input, ctx) {
      if (disposed || unavailable || current || runtime.signal.aborted) throw new StudioError('RUNTIME_UNAVAILABLE', 'ZCode runtime is unavailable or busy')
      const queue = new AgentEventQueue<AgentOutputEvent>(), pending = new Map<string, { resolve(value: any): void; choices: any[]; text: boolean }>()
      const nativeRequests = new Map<string, { ids: Set<string | number>; result: Promise<any>; withdraw(): void }>()
      let sequence = 0, cancelled = ctx.signal.aborted, finishing = false, rpc: NativeRpcConnection | undefined, prepared: Awaited<ReturnType<typeof prepareZcode>> | undefined
      let gateway: ModelGatewayHandle | undefined, cleanupFailure: unknown, nativeSessionId = checkpoint?.nativeSessionId, lastSequence = -1, terminal: any, gotUsage = false
      let nextCheckpoint: Checkpoint | undefined
      const callIds = new Set<string>(), tools = new Map<string, string>(), inputId = randomUUID()
      let assistantMessageId = 'zcode-answer'
      let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void
      const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject }); void settled.catch(() => {})
      const emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const usage = (value: any, id: string, model: string) => {
        if (scoped || callIds.has(id) || !value || !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0 || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0) return
        const counters: Record<string, number> = {}
        for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (value[key] !== undefined) {
          if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode usage')
          counters[key] = value[key]
        }
        if (callIds.size >= 4096) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many ZCode model calls')
        callIds.add(id); gotUsage = true
        emit({ type: 'usage.reported', modelCallId: `zcode-${ctx.scope.runId}-${id}`, model, mode: 'final', revision: 1, inputTokens: value.inputTokens, outputTokens: value.outputTokens, ...counters })
      }
      const withdraw = (id: string) => {
        const request = nativeRequests.get(id); if (!request) return
        for (const nativeId of request.ids) rpc?.withdrawRequest(nativeId)
        for (const key of [...pending.keys()]) if (key === id || key.startsWith(`${id}:`)) { pending.delete(key); emit({ type: 'interaction.withdrawn', requestId: key }) }
        request.withdraw(); nativeRequests.delete(id)
      }
      const notification = (method: string, event: Record<string, any>) => {
        if (cancelled || finishing || event.sessionId !== nativeSessionId) return
        if (method === 'v4/telemetry/event' && event.kind === 'usage.delta' && typeof event.requestId === 'string' && typeof event.modelId === 'string') usage(event, event.requestId, event.modelId)
        else if (method === 'session/event') {
          if (!Number.isSafeInteger(event.seq) || event.seq <= lastSequence) return
          lastSequence = event.seq
          const payload = event.payload || {}
          if (event.type === 'model.streaming' && ['text_delta', 'reasoning_delta'].includes(payload.kind) && typeof payload.delta === 'string') {
            if (typeof payload.assistantMessageId === 'string') assistantMessageId = payload.assistantMessageId
            emit({ type: payload.kind === 'text_delta' ? 'message.delta' : 'reasoning.delta', messageId: assistantMessageId, text: payload.delta })
          }
          else if (event.type === 'tool.updated' && typeof payload.toolCallId === 'string') {
            if (payload.kind === 'scheduled') { tools.set(payload.toolCallId, payload.toolName || 'tool'); emit({ type: 'tool.started', callId: payload.toolCallId, name: payload.toolName || 'tool', data: payload.input ?? null }) }
            else if (['result', 'error'].includes(payload.kind)) { emit({ type: payload.kind === 'error' ? 'tool.failed' : 'tool.completed', callId: payload.toolCallId, name: payload.toolName || tools.get(payload.toolCallId) || 'tool', data: payload.result ?? payload.error ?? null }); tools.delete(payload.toolCallId) }
          } else if (['permission.resolved', 'userInput.resolved'].includes(event.type) && typeof payload.requestId === 'string') withdraw(payload.requestId)
          else if (event.type === 'turn.failed' && (!payload.inputId || payload.inputId === inputId)) rejectSettled(new StudioError('RUNTIME_UNAVAILABLE', 'ZCode native turn failed'))
          else if (event.type === 'turn.completed' && (!payload.inputId || payload.inputId === inputId)) {
            if (payload.resultType !== 'success') rejectSettled(new StudioError('RUNTIME_UNAVAILABLE', 'ZCode did not complete its native turn'))
            else terminal = payload
          }
        } else if (method === 'state.updated' && terminal && event.reason === 'prompt_completed') resolveSettled()
      }
      const request = async (method: string, params: Record<string, any>, signal: AbortSignal, nativeId: string | number): Promise<any> => {
        if (method === 'session/requestRuntimePreferences') return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
        if (!['interaction/requestPermission', 'interaction/requestUserInput'].includes(method) || params.sessionId !== nativeSessionId || !params.requestId || signal.aborted || cancelled) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported ZCode client request')
        const id = String(params.requestId), existing = nativeRequests.get(id)
        if (existing) { existing.ids.add(nativeId); return existing.result }
        if (nativeRequests.size >= 32 || id.length > 200) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many ZCode interactions')
        let reject!: (error: unknown) => void
        const withdrawn = new Promise<never>((_, fail) => { reject = fail }); void withdrawn.catch(() => {})
        const ask = (key: string, prompt: string, choices: any[], text: boolean) => new Promise<any>(resolve => {
          if (choices.length > 32 || new Set(choices.map(choice => choice.id)).size !== choices.length || choices.some(choice => typeof choice.id !== 'string' || !choice.id || choice.id.length > 256 || typeof choice.label !== 'string' || choice.label.length > 4096)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode choices')
          pending.set(key, { resolve, choices, text }); emit({ type: 'interaction.requested', requestId: key, kind: method === 'interaction/requestPermission' ? 'approval' : 'clarification', prompt: prompt.slice(0, 16384) || 'ZCode input required', choices: choices.map(({ id, label, description }) => ({ id, label, ...(description ? { description } : {}) })), allowText: text })
        })
        const answers = (async () => {
          if (method === 'interaction/requestPermission') {
            if (!Array.isArray(params.options)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode permission')
            if (config.approvalRequired !== true) {
              const selected = params.options.find((option: any) => option?.response?.decision === 'allow')
              if (!selected) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode did not offer an automatic tool approval')
              return selected.response
            }
            const selected = await ask(id, `${params.toolName || 'Tool'}\n${params.reason || ''}`, params.options.map((option: any) => ({ id: option.optionId, label: option.name, response: option.response })), false)
            return selected.response
          }
          if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 4) return { action: 'decline' }
          const content: Record<string, string> = {}
          for (let index = 0; index < params.questions.length; index++) {
            const question = params.questions[index]
            if (typeof question.question !== 'string' || !Array.isArray(question.options)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode question')
            const selected = await ask(`${id}:${index}`, question.question + (question.multiSelect ? `\n${question.options.map((option: any) => option.label).join(', ')}` : ''), question.multiSelect ? [] : question.options.map((option: any, index: number) => ({ id: String(index), label: option.label, value: option.value })), true)
            content[question.question] = typeof selected === 'string' ? selected : selected.value
          }
          return { action: 'accept', content: { answers: content } }
        })()
        const result = Promise.race([answers, withdrawn])
        nativeRequests.set(id, { ids: new Set([nativeId]), result, withdraw: () => reject(new StudioError('CANCELLED', 'ZCode interaction withdrawn')) })
        return result
      }
      const stop = async () => { cancelled = true; rejectSettled(new StudioError('CANCELLED', 'ZCode run cancelled')); await rpc?.close() }
      const abort = () => { void stop().catch(() => {}) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        try {
          if (cancelled) return { status: 'cancelled' }
          const images = await readAgentImages(input.content, ctx), model = input.model || config.model as string | undefined
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped ZCode requires a Studio model')
          if (scoped && config.reasoningEffort && config.reasoningEffort !== 'disabled') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped ZCode supports the native disabled reasoning setting')
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'anthropic' }) : undefined
          if (images.size && gateway && gateway.images !== true) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          const configuration = mergeAgentContextConfiguration(config as AgentContextConfiguration, ctx.nativeContext || {})
          prepared = await prepareZcode(configuration, { ...config, ...(model ? { model } : {}) }, mode, runtime, ctx.signal, gateway)
          if (cancelled) return { status: 'cancelled' }
          const workspacePath = await realpath(cwd), workspace = { workspaceKey: workspacePath, workspacePath }
          const process = await runtime.processes.spawn({ command: prepared.launch.command, args: [...prepared.launch.args, 'app-server', '--stdio'], cwd: workspacePath, env: prepared.env })
          let resolveExit!: (value: { code: number | null; signal: string | null }) => void
          const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { resolveExit = resolve })
          rpc = new NativeRpcConnection({ ...process, read: async () => { const batch = await process.read(); if (batch.exit && !batch.chunks.length) resolveExit(batch.exit); return batch },
            write: data => process.write(data), end: () => process.end(), dispose: () => process.dispose() }, { notification, request })
          void rpc.closed.catch(error => { if (!finishing) rejectSettled(error) })
          await rpc.start()
          const snapshot = await rpc.request(checkpoint ? 'session/resume' : 'session/create', { workspace, ...(checkpoint ? { sessionId: checkpoint.nativeSessionId } : { mode: config.approvalRequired === true ? 'plan' : 'yolo', titleGenerationEnabled: false, ...(prepared.selection ? { model: prepared.selection } : {}) }), ...(prepared.mcpServers.length ? { mcpServers: prepared.mcpServers } : {}) })
          const session = snapshot?.session
          if (snapshot?.protocol?.name !== 'ZCode Protocol' || snapshot.protocol.version !== 1 || !validCheckpoint({ nativeSessionId: session?.sessionId }) || !await sameWorkspace(session.workspace?.workspacePath, workspacePath) || (checkpoint && session.sessionId !== checkpoint.nativeSessionId)) throw new StudioError('INVALID_ARGUMENT', 'ZCode restored a different native conversation')
          nativeSessionId = session.sessionId
          if (checkpoint) {
            await rpc.request('session/setMode', { sessionId: nativeSessionId, mode: config.approvalRequired === true ? 'plan' : 'yolo' })
            if (prepared.selection) await rpc.request('session/setModel', { sessionId: nativeSessionId, model: prepared.selection })
          }
          commands.update((snapshot.slashCommands || []).filter((command: any) => command.source !== 'builtin').map((command: any) => ({ name: command.name, description: command.description || '' })))
          await rpc.request('session/subscribe', { sessionId: nativeSessionId, deliveryKind: 'desktop-continuous', afterSeq: snapshot.runtime?.eventSeq || 0, includeSnapshot: false })
          const attachments = []
          for (const [id, image] of images) {
            const path = join(prepared.temporary, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[image.mediaType]}`)
            await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 }); attachments.push({ kind: 'image', localPath: path, filename: basename(path), mimeType: image.mediaType })
          }
          const text = input.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
          const guidance = [configuration.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n')
          const content = /^\/[\p{L}\p{N}_]/u.test(text) ? [text, guidance].filter(Boolean).join('\n\n') : [guidance, text || (attachments.length ? 'Inspect the attached images.' : '')].filter(Boolean).join('\n\n')
          if (/^\/(?:compact|compress)(?:\s|$)/.test(text)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode native compaction is not exposed by this adapter')
          const admitted = await rpc.request('session/send', { sessionId: nativeSessionId, inputId, content, ...(prepared.selection ? { modelSelection: prepared.selection } : {}), ...(attachments.length ? { attachments } : {}) })
          if (admitted?.accepted !== true || admitted.sessionId !== nativeSessionId) throw new StudioError('INVALID_ARGUMENT', 'ZCode did not accept this input')
          await settled
          if (typeof terminal?.response === 'string') emit({ type: 'message.snapshot', messageId: assistantMessageId, text: terminal.response })
          if (!gotUsage && terminal.usage?.source === 'provider') usage(terminal.usage, inputId, prepared.selection?.modelId || model || 'native')
          const final = await rpc.request('session/read', { sessionId: nativeSessionId })
          if (final?.session?.sessionId !== nativeSessionId || !await sameWorkspace(final.session.workspace?.workspacePath, workspacePath) || final.session.status !== 'idle') throw new StudioError('RUNTIME_UNAVAILABLE', 'ZCode did not settle this native conversation')
          finishing = true; await process.end()
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const exit = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'ZCode did not exit after its final result')), 2000) })])
            if (exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'ZCode failed after its final result')
          } finally { clearTimeout(timer) }
          await commands.drain(); nextCheckpoint = { nativeSessionId: nativeSessionId! }
          return { status: 'completed', checkpoint: { nativeSessionId: nextCheckpoint.nativeSessionId } }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          emit({ type: 'diagnostic', message: error instanceof StudioError || error instanceof Error && /^Native RPC request failed \(-?\d+\)$/.test(error.message) ? error.message : 'ZCode native protocol failed' })
          queue.fail(error instanceof Error ? error : new Error('ZCode run failed')); throw error
        } finally {
          finishing = true; ctx.signal.removeEventListener('abort', abort)
          for (const id of nativeRequests.keys()) withdraw(id)
          pending.clear()
          try {
            try { await rpc?.close() } finally { try { await prepared?.dispose() } finally { if (!ctx.signal.aborted) await gateway?.dispose() } }
            if (nextCheckpoint && !cancelled) checkpoint = nextCheckpoint
          }
          catch (error) { unavailable = true; cleanupFailure = error; throw error }
          finally { queue.end(); current = undefined }
        }
      })()
      void result.catch(() => {})
      const handle: AgentRunHandle = { events: queue, result, async cancel() { await stop(); await result.catch(() => {}); if (cleanupFailure) throw cleanupFailure },
        async respond(response) {
          const entry = pending.get(response.requestId)
          if (!entry) return { status: 'withdrawn' }
          const choice = entry.choices.find(choice => choice.id === response.choiceId)
          if (!choice && (!entry.text || typeof response.text !== 'string')) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode response')
          pending.delete(response.requestId); entry.resolve(choice || response.text)
        } }
      current = handle; return handle
    },
    async dispose() { disposed = true; await current?.cancel('ZCode runtime disposed') },
  }
}
