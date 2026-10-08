import type { ChildProcess } from 'node:child_process'
import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import type { CodingAgentImageInput } from '../../protocol/types'
import { updateSession } from '../../../studio/public/sessions'
import { updateContextTokenUsage } from '../../../studio/public/run-state'
import { updateManagedPromptFileSync } from '../prompt-file'
import { isolatedCodingAgentChildEnv } from '../runtime/child-env'
import { DshAcpTurn } from './acp-turn'
import { DSH_MAX_AUTO_CONTINUES, DSH_MODEL_PROVIDER, dshIsNarrationOnlyStall } from './runtime-config'
import { normalizeTokenUsage, recordSessionUsage } from '../../../studio/public/usage'

export interface DshTurnHost {
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
  emit(event: string, payload: any): void
  completeAfterUsage(event: any, payload: any): Promise<void>
  complete(): void
  fail(message: string): void
  /** Re-dispatch this DSH run with the auto-continue nudge (no new user row).
   * Present only when the caller opts into the #3326 hard-fallback. */
  autoContinue?: () => void
}

/** ACP lifecycle and event translation belong to DSH; the shared manager only
 * supplies its existing process, persistence and presentation primitives. */
export function startDshChatTurn(run: ManagedCodingAgentRun, input: string, systemPrompt: string, images: CodingAgentImageInput[], host: DshTurnHost) {
  if (host.isRunning(run.currentChild)) throw new Error('DSH is still processing the previous input')
  // DSH's session/prompt runs a MULTI-STEP agent loop inside one child process:
  // the model alternates tool-call steps and text steps, and the prompt only
  // returns once the model emits a tool-less step (stopReason end_turn). So a
  // narration-only "Let me …:" can be the terminal step of a prompt whose
  // EARLIER steps already ran real tools. The stall must therefore be judged on
  // the text of the terminal step alone — the text emitted since the last tool
  // call — not on run.printText / run.codexToolBlocks, which span the whole
  // prompt and would let an earlier tool mask the terminal stall.
  let textSinceLastTool = ''
  const responseId = `resp_${Date.now()}`
  Object.assign(run, {
    printResponseId: responseId, printMessageId: `msg_${responseId}`, printTextStarted: false,
    printText: '', printCompleted: false, responseStartEmitted: false, terminalEventHandled: false,
    codexToolBlocks: new Map(), currentChildStderr: '', runMarker: undefined, memoryExportStarted: false,
    pendingChatCompletionEvent: undefined, pendingChatCompletionPayload: undefined,
  })
  if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)
  host.response({ type: 'response.created', data: {
    type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
  } })
  const child = host.spawn(run.launch.command, run.launch.args, {
    cwd: run.launch.workspaceDir, pipeStdin: true,
    env: run.launch.mode === 'global' ? { ...process.env, ...run.launch.env } : isolatedCodingAgentChildEnv(run.launch.env),
  })
  run.currentChild = child
  const turn = new DshAcpTurn(child, {
    permissionRequired: run.launch.approvalRequired,
    usage: event => {
      // Scoped calls are already owned by the provider proxy ledger.
      if (run.launch.mode !== 'global' || !event || typeof event.requestId !== 'string' || !event.requestId) return
      const usage = normalizeTokenUsage(event.usage)
      if (usage.isEstimated) return
      recordSessionUsage({
        sessionId: run.launch.sessionId, runId: `dsh:${event.requestId}`,
        parentRunId: run.usageRunId || run.id, source: 'coding_agent', agent: 'dsh',
        profile: run.launch.profile, usageScope: 'model_call', apiCalls: 1,
        apiDuration: event.apiDuration, usage,
        model: typeof event.model === 'string' ? event.model : '',
        provider: typeof event.provider === 'string' ? event.provider : '', isEstimated: false,
      })
    },
    session: id => {
      run.launch.agentNativeSessionId = id
      run.nativeResumeReady = true
      updateSession(run.launch.sessionId, { agent_native_session_id: id })
    },
    config: options => {
      if (run.launch.mode !== 'global') return
      const model = options.find(option => option.id === 'model')?.currentValue
      try {
        const [, name] = JSON.parse(model)
        if (typeof name === 'string') {
          run.launch.model = name
          updateSession(run.launch.sessionId, { model: name })
        }
      } catch { /* Older ACP implementations may use opaque model values. */ }
    },
    update: update => {
      if (run.exited || run.stoppedByUser || run.printCompleted) return
      host.touch()
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        textSinceLastTool += update.content.text
        host.text(update.content.text, true)
      }
      else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') host.reasoning(update.content.text)
      else if (update.sessionUpdate === 'tool_call') {
        textSinceLastTool = '' // a real tool ran; any later text is a NEW step
        host.toolStarted({
          type: 'mcp_tool_call', id: update.toolCallId, tool: update.title || 'DSH tool', arguments: update.rawInput,
        })
      }
      else if (update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
        const output = update.rawOutput ?? (update.content || []).map((entry: any) => entry.content?.text || '').join('\n')
        host.toolCompleted({ type: 'mcp_tool_call', id: update.toolCallId, output,
          ...(update.status === 'failed' ? { error: { message: String(output) } } : {}),
        })
      }
      else if (update.sessionUpdate === 'usage_update' && Number.isFinite(update.used)) {
        updateContextTokenUsage(run.launch.sessionId, run.state, (event: string, payload: any) => host.emit(event, payload), update.used)
      }
    },
  })
  run.dshTurn = turn
  child.stderr?.on('data', (chunk: Buffer) => { host.stderr(chunk); host.touch() })
  child.on('close', code => {
    if (run.currentChild !== child) return
    run.currentChild = undefined
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    if (run.exited || run.stoppedByUser) return
    if (run.pendingChatCompletionEvent) {
      void host.completeAfterUsage(run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
    } else if (run.dshAutoContinuePending) {
      // A narration-only stall triggered an auto-continue: the new child owns the
      // turn's completion/failure. Do not surface this old child's exit as a fail.
      run.dshAutoContinuePending = undefined
    } else if (!run.printCompleted) host.fail(host.exitError(code, run.currentChildStderr))
  })
  void turn.prompt({
    cwd: run.launch.workspaceDir, text: input, images,
    agentPreset: run.launch.agentPreset,
    nativeSessionId: run.nativeResumeReady ? run.launch.agentNativeSessionId : undefined,
    modelValue: run.launch.mode === 'scoped' ? JSON.stringify([DSH_MODEL_PROVIDER, run.launch.model]) : undefined,
    reasoningEffort: run.launch.mode === 'scoped' ? run.launch.reasoningEffort : undefined,
  }).then(reason => {
    if (run.exited || run.stoppedByUser) return
    if (reason === 'end_turn' || reason === 'max_tokens') {
      // #3326 hard fallback: a tool-less step ending in "Let me …:" is a
      // narration-only stall. If we still have auto-continue budget and the
      // caller opted in, re-dispatch the nudge instead of surfacing a completed
      // turn that just waits for the user to type "继续".
      // Judge on the terminal step's text only. textSinceLastTool is the text
      // emitted after the last tool call (i.e. the final step's narration); it is
      // empty if the prompt ended on a tool call. The final step made no tool
      // call (it is the tool-less end_turn step), so pass toolCallCount 0.
      const stalled = dshIsNarrationOnlyStall(reason, textSinceLastTool, 0)
      const budgetLeft = (run.dshAutoContinueCount || 0) < DSH_MAX_AUTO_CONTINUES
      if (stalled && budgetLeft && host.autoContinue) {
        // Arm the guard synchronously, before the old child's close handler can
        // observe turn state, so a clean end_turn exit is not misreported as a
        // failure while the re-dispatched child owns completion.
        run.dshAutoContinuePending = true
        host.autoContinue()
        return
      }
      host.complete()
    } else host.fail(`DSH stopped: ${reason}`)
  }).catch(error => {
    if (!run.exited && !run.stoppedByUser) host.fail(host.processError(error))
    host.terminate(child)
  }).finally(() => {
    turn.dispose()
    if (run.dshTurn === turn) run.dshTurn = undefined
    if (host.isRunning(child)) {
      run.currentChildKillTimer = setTimeout(() => host.forceKill(child), 1500)
    }
  })
}
