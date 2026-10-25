import { randomUUID } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { AgentEventQueue, acpCommandCatalog } from '@ekko-studio/agent-drivers'
import { StudioError, mergeAgentContextConfiguration, nativeAgentLaunch, readAgentImages, type AgentContextConfiguration, type AgentOutputEvent,
  type AgentRunHandle, type AgentRunResult, type AgentRuntime, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle, type RuntimeCreateInput } from '@ekko-studio/plugin-sdk'
import { preparePi } from './configuration'
import { PiRpc, type PiRecord } from './rpc'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
interface Checkpoint { nativeSessionId: string; nativeSessionFile: string }
async function verifyCheckpoint(value: Checkpoint, sessions: string) {
  if (!value || Object.keys(value).some(key => !['nativeSessionId', 'nativeSessionFile'].includes(key)) || typeof value.nativeSessionId !== 'string'
    || !value.nativeSessionId || value.nativeSessionId.length > 256 || typeof value.nativeSessionFile !== 'string' || !isAbsolute(value.nativeSessionFile)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Pi checkpoint')
  const root = await realpath(sessions), path = await realpath(value.nativeSessionFile), difference = relative(root, path)
  if (!difference || difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new StudioError('INVALID_ARGUMENT', 'Pi history is outside its managed storage')
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(8192), { bytesRead } = await file.read(buffer, 0, buffer.length, 0), end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) throw new Error('Missing session header')
    const header = JSON.parse(buffer.subarray(0, end).toString())
    if (header.type !== 'session' || header.id !== value.nativeSessionId) throw new Error('Session identity changed')
  } catch { throw new StudioError('INVALID_ARGUMENT', 'Pi history does not match its checkpoint') }
  finally { await file.close() }
}

export function createPiRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config, cwd = String(config.cwd), mode = input.mode, scoped = mode === 'scoped'
  if (!isAbsolute(cwd) || !runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Pi requires an absolute workspace and host-managed storage')
  const saved = mergeAgentContextConfiguration(config as AgentContextConfiguration)
  const commands = acpCommandCatalog(runtime, { pluginId: 'studio.agent-pi', agentTypeId: 'pi', name: 'Pi', staticIds: { compact: 'studio.agent-pi/compact' } })
  let checkpoint = input.resume as unknown as Checkpoint | undefined, current: AgentRunHandle | undefined, disposed = false
  return {
    async run(input, ctx) {
      if (disposed || runtime.signal.aborted || current) throw new StudioError('RUNTIME_UNAVAILABLE', 'Pi runtime is unavailable or busy')
      const queue = new AgentEventQueue<AgentOutputEvent>(), pending = new Map<string, { method: string; options: string[]; timer?: ReturnType<typeof setTimeout> }>()
      let sequence = 0, message = 0, notice = 0, compaction = 0, selectedModel: string | undefined, cancelled = ctx.signal.aborted, finishing = false, rpc: PiRpc | undefined
      let prepared: Awaited<ReturnType<typeof preparePi>> | undefined, gateway: ModelGatewayHandle | undefined, cleanupFailure: unknown
      let settledResolve!: () => void, settledReject!: (error: unknown) => void, lastError: string | undefined
      const settled = new Promise<void>((resolve, reject) => { settledResolve = resolve; settledReject = reject }); void settled.catch(() => {})
      const emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const reportUsage = (usage: any, model: string | undefined, call: string) => {
        if (scoped || !model || !usage || !['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return
        const total = usage.input + usage.cacheRead + usage.cacheWrite
        if (!Number.isSafeInteger(total)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Pi token usage')
        emit({ type: 'usage.reported', modelCallId: `pi-${ctx.scope.runId}-${call}`, model, mode: 'final', revision: 1,
          inputTokens: total, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite })
      }
      const withdraw = (id: string) => { const entry = pending.get(id); if (!entry) return; clearTimeout(entry.timer); pending.delete(id); emit({ type: 'interaction.withdrawn', requestId: id }) }
      const nativeEvent = (event: PiRecord) => {
        if (cancelled || finishing) return
        if (event.type === 'message_start' && event.message?.role === 'assistant') message++
        else if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (['text_delta', 'thinking_delta'].includes(update?.type) && typeof update.delta === 'string') emit({ type: update.type === 'text_delta' ? 'message.delta' : 'reasoning.delta', messageId: `pi-${message}`, text: update.delta })
        } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const value = event.message
          lastError = ['error', 'aborted'].includes(value.stopReason) ? 'Pi model call did not complete' : undefined
          const text = Array.isArray(value.content) ? value.content.filter((part: any) => part.type === 'text').map((part: any) => String(part.text)).join('') : ''
          if (text) emit({ type: 'message.snapshot', messageId: `pi-${message}`, text })
          if (typeof value.provider === 'string' && typeof value.model === 'string') selectedModel = `${value.provider}/${value.model}`
          reportUsage(value.usage, selectedModel, `message-${message}`)
        } else if (event.type === 'compaction_end') {
          // Native summary calls do not emit assistant message_end records.
          reportUsage(event.result?.usage, selectedModel, `compaction-${++compaction}`)
        } else if (['tool_execution_start', 'tool_execution_end'].includes(event.type)) {
          emit({ type: event.type === 'tool_execution_start' ? 'tool.started' : event.isError ? 'tool.failed' : 'tool.completed',
            callId: event.toolCallId, name: event.toolName, data: (event.type === 'tool_execution_start' ? event.args : event.result) ?? null })
        } else if (event.type === 'extension_ui_request') {
          const id = event.id, method = event.method
          if (method === 'notify') { if (typeof event.message === 'string') emit({ type: 'message.delta', messageId: `pi-notice-${++notice}`, text: event.message }); return }
          if (!['confirm', 'select', 'input', 'editor'].includes(method)) return
          if (typeof id !== 'string' || !id || id.length > 256 || pending.has(id) || pending.size >= 32) throw new StudioError('INVALID_ARGUMENT', 'Invalid Pi dialog')
          if (method === 'confirm' && config.approvalRequired !== true) {
            void rpc?.notify({ type: 'extension_ui_response', id, confirmed: true }).catch(settledReject)
            return
          }
          const options = method === 'select' ? event.options : []
          if (!Array.isArray(options) || options.length > 32 || options.some(option => typeof option !== 'string' || !option || option.length > 4096) || new Set(options).size !== options.length) throw new StudioError('INVALID_ARGUMENT', 'Invalid Pi choices')
          const entry = { method, options } as { method: string; options: string[]; timer?: ReturnType<typeof setTimeout> }
          pending.set(id, entry)
          const timeout = typeof event.timeout === 'number' && Number.isFinite(event.timeout) && event.timeout > 0 ? Math.min(event.timeout, 600000) : undefined
          if (timeout) entry.timer = setTimeout(() => { withdraw(id); void rpc?.notify({ type: 'extension_ui_response', id, cancelled: true }).catch(settledReject) }, timeout)
          emit({ type: 'interaction.requested', requestId: id, kind: method === 'confirm' ? 'approval' : 'clarification',
            prompt: [event.title, event.message].filter(value => typeof value === 'string').join('\n').slice(0, 16384) || 'Pi input required',
            choices: method === 'confirm' ? [{ id: 'yes', label: 'Allow' }, { id: 'no', label: 'Reject' }] : options.map((label, index) => ({ id: String(index), label })),
            allowText: ['input', 'editor'].includes(method), ...(timeout ? { expiresAt: Date.now() + timeout } : {}) })
        } else if (event.type === 'agent_settled') {
          for (const id of pending.keys()) withdraw(id)
          if (event.aborted || lastError) settledReject(new StudioError('RUNTIME_UNAVAILABLE', lastError || 'Pi stopped before completion'))
          else settledResolve()
        }
      }
      const stop = async () => { cancelled = true; settledReject(new StudioError('CANCELLED', 'Pi run cancelled')); await rpc?.dispose() }
      const abort = () => { void stop().catch(() => {}) }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        try {
          if (cancelled) return { status: 'cancelled' }
          const images = await readAgentImages(input.content, ctx), model = input.model || config.model as string | undefined
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Pi requires a Studio model')
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'responses' }) : undefined
          if (images.size && gateway && !gateway.images) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          const text = input.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), nativeCommand = /^\/[\p{L}\p{N}_]/u.test(text)
          const configuration = mergeAgentContextConfiguration(saved, ctx.nativeContext || {})
          prepared = await preparePi({ ...configuration, systemPrompt: nativeCommand ? '' : [configuration.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n') }, { ...config, ...(model ? { model } : {}) }, mode, runtime, gateway)
          if (checkpoint) await verifyCheckpoint(checkpoint, prepared.sessions)
          if (cancelled) return { status: 'cancelled' }
          const launch = nativeAgentLaunch('pi', config, runtime)
          const process = await runtime.processes.spawn({ command: launch.command, cwd, args: [...launch.args, ...prepared.args, '--mode', 'rpc', '--offline',
            '--extension', join(__dirname, '../native/studio.mjs'), ...(checkpoint ? ['--session', checkpoint.nativeSessionFile] : [])],
            env: { ...config.env as Record<string, string>, ...prepared.env } })
          rpc = new PiRpc(process, nativeEvent, error => { if (!finishing) settledReject(error) })
          if (cancelled) return { status: 'cancelled' }
          await rpc.start()
          const initialState = await rpc.request('get_state')
          // Pi reports extension-load errors and may otherwise continue with native defaults.
          await prepared.ready()
          if (typeof initialState?.model?.provider === 'string' && typeof initialState?.model?.id === 'string') selectedModel = `${initialState.model.provider}/${initialState.model.id}`
          const catalog = await rpc.request('get_commands')
          commands.update((catalog?.commands || []).map((command: any) => ({ name: command.name, description: command.description || '' })))
          if (/^\/compact(?:\s|$)/.test(text)) {
            if (images.size) throw new StudioError('INVALID_ARGUMENT', 'Pi compaction does not accept images')
            const compacted = await rpc.request('compact', { customInstructions: text.slice('/compact'.length).trim() })
            if (typeof compacted?.summary === 'string') emit({ type: 'message.snapshot', messageId: 'pi-compaction', text: compacted.summary })
          } else {
            const admitted = await rpc.request('prompt', { message: text, ...(images.size ? { images: [...images.values()].map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data })) } : {}) })
            if (admitted?.disposition !== 'handled') await settled
          }
          const state = await rpc.request('get_state')
          const next = { nativeSessionId: state?.sessionId, nativeSessionFile: state?.sessionFile }
          finishing = true
          await rpc.end()
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const exit = await Promise.race([rpc.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StudioError('DEADLINE_EXCEEDED', 'Pi did not exit after its final result')), 1500) })])
            if (exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Pi failed after its final result')
          } finally { clearTimeout(timer) }
          await verifyCheckpoint(next, prepared.sessions)
          await commands.drain()
          checkpoint = next
          return { status: 'completed', checkpoint: next }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          queue.fail(error instanceof Error ? error : new Error('Pi run failed')); throw error
        } finally {
          finishing = true; ctx.signal.removeEventListener('abort', abort)
          for (const entry of pending.values()) clearTimeout(entry.timer)
          pending.clear()
          try { try { await rpc?.dispose() } finally { try { if (!ctx.signal.aborted) await gateway?.dispose() } finally { await prepared?.dispose() } } }
          catch (error) { cleanupFailure = error; throw error }
          finally { queue.end(); current = undefined }
        }
      })()
      void result.catch(() => {})
      const handle: AgentRunHandle = { events: queue, result, async cancel() { await stop(); await result.catch(() => {}); if (cleanupFailure) throw cleanupFailure },
        async respond(response) {
          const entry = pending.get(response.requestId)
          if (!entry) return { status: 'withdrawn' }
          const value = entry.method === 'confirm' ? response.choiceId === 'yes' : entry.method === 'select' ? entry.options[Number(response.choiceId)] : response.text
          if ((entry.method === 'confirm' && !['yes', 'no'].includes(response.choiceId || '')) || (entry.method === 'select' && (!response.choiceId || String(Number(response.choiceId)) !== response.choiceId || value === undefined))
            || (['input', 'editor'].includes(entry.method) && typeof value !== 'string')) throw new StudioError('INVALID_ARGUMENT', 'Invalid Pi dialog response')
          clearTimeout(entry.timer); pending.delete(response.requestId)
          await rpc!.notify({ type: 'extension_ui_response', id: response.requestId, ...(entry.method === 'confirm' ? { confirmed: value } : { value }) })
        } }
      current = handle
      return handle
    },
    async dispose() { disposed = true; await current?.cancel('Pi runtime disposed') },
  }
}
