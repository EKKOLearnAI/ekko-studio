import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import { updateSession } from '../../../studio/public/sessions'
import { NATIVE_CODING_AGENTS } from '../../../studio/contracts/agents/native-coding-agents'
import { NativeAcpTurn } from './acp-turn'
import type { CodingAgentImageInput } from '../../protocol/types'
import { prepareZcodePrompt } from './zcode-prompt'

export interface NativeTurnHost {
  spawn(command: string, args: string[], options: { cwd: string; pipeStdin: boolean; env: NodeJS.ProcessEnv }): ChildProcess
  isRunning(child?: ChildProcess): boolean
  terminate(child?: ChildProcess): void
  forceKill(child?: ChildProcess): void
  processError(error: unknown): string
  exitError(code: number | null, stderr?: string): string
  stderr(chunk: Buffer): void
  touch(): void
  response(event: any): void
  text(text: string, live: boolean): void
  reasoning(text: string): void
  toolStarted(item: any): void
  toolCompleted(item: any): void
  completeAfterUsage(event: any, payload: any): Promise<void>
  complete(usage?: any): void
  fail(message: string): void
}

export function acpMcpServers(servers: Record<string, any>): object[] {
  return Object.entries(servers).filter(([, config]) => config.enabled !== false && !config.disabled).map(([name, config]) => {
    if (config.url) return { name, type: config.type === 'sse' ? 'sse' : 'http', url: config.url,
      headers: Object.entries(config.headers || {}).map(([name, value]) => ({ name, value: String(value) })) }
    return { name, command: config.command, args: config.args || [],
      env: Object.entries(config.env || {}).map(([name, value]) => ({ name, value: String(value) })) }
  })
}

export function applyNativeAcpUpdate(update: any, host: Pick<NativeTurnHost, 'text' | 'reasoning' | 'toolStarted' | 'toolCompleted'>) {
  if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') host.text(update.content.text, true)
  else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') host.reasoning(update.content.text)
  else if (update?.sessionUpdate === 'tool_call') {
    host.toolStarted({ type: 'mcp_tool_call', id: update.toolCallId, tool: update.title || update.kind || 'tool', arguments: update.rawInput })
    if (['completed', 'failed'].includes(update.status)) applyNativeAcpUpdate({ ...update, sessionUpdate: 'tool_call_update' }, host)
  } else if (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
    const output = update.rawOutput ?? (update.content || []).map((entry: any) => entry.content?.text || '').join('\n')
    host.toolCompleted({ type: 'mcp_tool_call', id: update.toolCallId, output,
      ...(update.status === 'failed' ? { error: { message: typeof output === 'string' ? output : JSON.stringify(output) } } : {}) })
  }
}

export function applyZcodeEvent(event: any, host: Pick<NativeTurnHost, 'text' | 'reasoning' | 'toolStarted' | 'toolCompleted' | 'fail'>) {
  const payload = event?.payload || {}
  if (event.type === 'model.streaming' && payload.kind === 'text_delta') host.text(String(payload.delta || ''), true)
  else if (event.type === 'model.streaming' && payload.kind === 'reasoning_delta') host.reasoning(String(payload.delta || ''))
  else if (event.type === 'tool.updated' && payload.kind === 'scheduled') host.toolStarted({
    type: 'mcp_tool_call', id: payload.toolCallId, tool: payload.toolName || 'tool', arguments: payload.input,
  })
  else if (event.type === 'tool.updated' && ['result', 'error'].includes(payload.kind)) host.toolCompleted({
    type: 'mcp_tool_call', id: payload.toolCallId, output: payload.result?.content ?? payload.result ?? payload.error?.message ?? '',
    ...(payload.kind === 'error' ? { error: payload.error } : {}),
  })
  else if (event.type === 'turn.failed') host.fail(payload.error?.message || payload.message || 'ZCode turn failed')
}

export function startNativeChatTurn(run: ManagedCodingAgentRun, input: string, systemPrompt: string, host: NativeTurnHost, images: CodingAgentImageInput[] = []) {
  const definition = NATIVE_CODING_AGENTS.find(agent => agent.id === run.launch.agentId)
  if (!definition) throw new Error('Unknown native coding agent')
  if (host.isRunning(run.currentChild)) throw new Error(`${definition.name} is still processing the previous input`)
  const responseId = `resp_${Date.now()}`
  Object.assign(run, {
    printResponseId: responseId, printMessageId: `msg_${responseId}`, printTextStarted: false,
    printText: '', printCompleted: false, responseStartEmitted: false, terminalEventHandled: false,
    codexToolBlocks: new Map(), currentChildStderr: '', runMarker: undefined, memoryExportStarted: false,
    pendingChatCompletionEvent: undefined, pendingChatCompletionPayload: undefined,
  })
  host.response({ type: 'response.created', data: {
    type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model: '', output: [] },
  } })
  const text = [systemPrompt || run.launch.nativeSystemPrompt, input].filter(Boolean).join('\n\n')
    || (images.length ? 'Inspect the attached images.' : '')
  const prepared = definition.id === 'zcode' ? prepareZcodePrompt(run.launch.command,
    [...run.launch.args, '--output-format', 'stream-json', '--mode', run.launch.approvalRequired ? 'plan' : 'yolo',
      ...(run.nativeResumeReady && run.launch.agentNativeSessionId ? ['--resume', run.launch.agentNativeSessionId] : []),
      ...images.flatMap(image => ['--attach', image.path])], text) : undefined
  const args = prepared?.args || [...run.launch.args, ...definition.acpArgs]
  let child: ChildProcess
  try {
    child = host.spawn(run.launch.command, args, {
      cwd: run.launch.workspaceDir, pipeStdin: true, env: { ...process.env, ...run.launch.env },
    })
  } catch (error) { prepared?.cleanup(); throw error }
  run.currentChild = child
  let finished = false
  let connection: NativeAcpTurn | undefined
  const session = (id: string) => {
    run.launch.agentNativeSessionId = id
    run.nativeResumeReady = true
    updateSession(run.launch.sessionId, { agent_native_session_id: id })
  }
  const finish = (error?: string, usage?: any) => {
    if (finished || run.exited || run.stoppedByUser) return
    finished = true
    if (error) host.fail(error)
    else host.complete(usage)
  }
  child.stderr?.on('data', (chunk: Buffer) => { host.stderr(chunk); host.touch() })
  child.stdin?.on('error', error => { finish(host.processError(error)); host.terminate(child) })
  child.on('error', error => { prepared?.cleanup(); finish(host.processError(error)) })
  child.on('close', code => {
    prepared?.cleanup()
    if (run.currentChild !== child) return
    run.currentChild = undefined
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    run.currentChildKillTimer = undefined
    if (!finished) finish(definition.id === 'zcode' && code === 0
      ? 'ZCode exited without a final result'
      : host.exitError(code, run.currentChildStderr))
    if (!run.exited && !run.stoppedByUser && run.pendingChatCompletionEvent) {
      void host.completeAfterUsage(run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
    }
  })
  if (definition.id === 'zcode') {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    const receive = (line: string) => {
      if (!line.trim() || finished || run.exited || run.stoppedByUser) return
      const event = JSON.parse(line)
      if (typeof event.sessionId === 'string') session(event.sessionId)
      applyZcodeEvent(event, { ...host, fail: message => finish(message) })
      if (event.type === 'result') {
        if (!run.printText && event.response) host.text(String(event.response), true)
        const status = event.projection?.status
        finish(status === 'error' || status === 'failed' ? 'ZCode run failed' : undefined, event.usage)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      host.touch()
      try {
        buffer += decoder.write(chunk)
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (line.length > 16 * 1024 * 1024) throw new Error('ZCode message exceeds 16 MiB')
          receive(line)
        }
        if (buffer.length > 16 * 1024 * 1024) throw new Error('ZCode message exceeds 16 MiB')
      } catch (error) { finish(host.processError(error)); host.terminate(child) }
    })
    child.stdout?.on('end', () => {
      try { receive(buffer + decoder.end()); buffer = '' }
      catch (error) { finish(host.processError(error)); host.terminate(child) }
    })
    child.stdin?.end()
  } else {
    connection = new NativeAcpTurn(child, {
      session, permissionRequired: run.launch.approvalRequired,
      update: update => { if (!run.exited && !run.stoppedByUser && !finished) { host.touch(); applyNativeAcpUpdate(update, host) } },
    })
    run.nativeAcpTurn = connection
    void connection.prompt({ cwd: run.launch.workspaceDir, text, images,
      nativeSessionId: run.nativeResumeReady ? run.launch.agentNativeSessionId : undefined,
      mcpServers: acpMcpServers(run.launch.nativeMcpServers || {}),
    }).then(reason => finish(['end_turn', 'max_tokens'].includes(reason) ? undefined : `${definition.name} stopped: ${reason}`))
      .catch(error => { finish(host.processError(error)); host.terminate(child) })
      .finally(() => {
        connection?.dispose()
        if (run.nativeAcpTurn === connection) run.nativeAcpTurn = undefined
        if (host.isRunning(child)) run.currentChildKillTimer = setTimeout(() => host.forceKill(child), 1500)
      })
  }
}
