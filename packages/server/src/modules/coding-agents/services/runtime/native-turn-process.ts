import type { ManagedCodingAgentRun } from './run-manager'
import type { NativeTurnHost } from './turn-host'
import { updateSession } from '../../../studio/public/sessions'

export function startNativeTurnProcess(run: ManagedCodingAgentRun, message: string, systemPrompt: string, host: NativeTurnHost, input: {
  name: string
  args(text: string): string[]
  exitError?(code: number | null): string | undefined
}) {
  if (host.isRunning(run.currentChild)) throw new Error(`${input.name} is still processing the previous input`)
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
  const text = [systemPrompt || run.launch.nativeSystemPrompt, message].filter(Boolean).join('\n\n')
  const child = host.spawn(run.launch.command, input.args(text), {
    cwd: run.launch.workspaceDir, pipeStdin: true, env: { ...process.env, ...run.launch.env },
  })
  run.currentChild = child
  let finished = false
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
  child.on('error', error => finish(host.processError(error)))
  child.on('close', code => {
    if (run.currentChild !== child) return
    run.currentChild = undefined
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    run.currentChildKillTimer = undefined
    if (!finished) finish(input.exitError?.(code) || host.exitError(code, run.currentChildStderr))
    if (!run.exited && !run.stoppedByUser && run.pendingChatCompletionEvent) {
      void host.completeAfterUsage(run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
    }
  })
  return { child, text, session, finish, isFinished: () => finished }
}
