import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { CodingAgentImageInput } from '../../protocol/types'
import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import type { OpenCodeTurnHost } from './turn-host'
import { logger } from '../../../studio/public/logging'
import { updateManagedPromptFileSync } from '../prompt-file'
import { isolatedCodingAgentChildEnv } from '../runtime/child-env'

export function startOpenCodeTurn(
  run: ManagedCodingAgentRun,
  input: string,
  systemPrompt = '',
  images: CodingAgentImageInput[],
  host: OpenCodeTurnHost,
) {
  if (host.isRunning(run.currentChild)) {
    throw new Error('OpenCode is still processing the previous input')
  }

  const responseId = `resp_${Date.now()}`
  run.printResponseId = responseId
  run.printMessageId = `msg_${responseId}`
  run.printTextStarted = false
  run.printText = ''
  run.printCompleted = false
  run.responseStartEmitted = false
  run.terminalEventHandled = false
  run.currentChildStderr = ''
  run.runMarker = undefined
  run.memoryExportStarted = false

  host.response({
    type: 'response.created',
    data: {
      type: 'response.created',
      response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
    },
  })

  if (run.launch.promptFile) updateManagedPromptFileSync(run.launch.promptFile, systemPrompt)
  const args = [
    'run',
    '--format', 'json',
    '--agent', 'build',
    '--auto',
    '--thinking',
    ...run.launch.args,
    ...(run.launch.agentNativeSessionId && run.nativeResumeReady
      ? ['--session', run.launch.agentNativeSessionId]
      : []),
    ...images.flatMap(image => ['--file', image.path]),
  ]
  const child = host.spawn(run.launch.command, args, {
    cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
    env: run.launch.mode === 'global'
      ? { ...process.env, ...(run.launch.env || {}) }
      : isolatedCodingAgentChildEnv(run.launch.env),
    pipeStdin: true,
  })
  run.currentChild = child

  child.stdin?.on('error', err => {
    if (!run.printCompleted && !run.stoppedByUser) host.fail(host.processError(err))
    host.terminate(child)
  })

  let stdoutBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    host.touch()
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) host.line(line)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    host.touch()
    const text = host.stderr(chunk)
    if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] opencode stderr')
  })
  child.on('error', (err) => {
    run.currentChild = undefined
    logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] opencode failed to start')
    if (!run.printCompleted) host.fail(host.processError(err))
  })
  child.on('close', (code) => {
    if (stdoutBuffer.trim()) host.line(stdoutBuffer)
    run.currentChild = undefined
    logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] opencode exited')
    if (run.stoppedByUser) return
    if (run.pendingChatCompletionEvent) {
      void host.completeAfterUsage(run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
      return
    }
    if (run.printCompleted) return
    if (code === 0) host.complete()
    else host.fail(host.exitError(code, run.currentChildStderr))
  })
  child.stdin?.end(input || (images.length ? 'Inspect the attached images.' : ''))
}
