import { StringDecoder } from 'node:string_decoder'
import type { ManagedCodingAgentRun } from '../runtime/run-manager'
import type { NativeTurnHost } from '../runtime/turn-host'
import { startNativeTurnProcess } from '../runtime/native-turn-process'
import { applyZcodeEvent } from './event-adapter'
import type { CodingAgentImageInput } from '../../protocol/types'
import { prepareZcodePrompt } from './prompt'

// Read the prompt before executing the CJS entrypoint as Node's main module.
// Windows command lines cannot carry arbitrary multiline/long chat content.
const WINDOWS_PROMPT_BRIDGE = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.argv=[process.execPath,...JSON.parse(input)];require('node:module').runMain()})"

export function startZcodeChatTurn(definition: { name: string }, run: ManagedCodingAgentRun, input: string, systemPrompt: string, host: NativeTurnHost, images: CodingAgentImageInput[] = []) {
  const bridge = process.platform === 'win32' && run.launch.command === process.execPath && /\.cjs$/i.test(run.launch.args[0] || '')
  const baseArgs = [...run.launch.args, '--output-format', 'stream-json', '--mode', run.launch.approvalRequired ? 'plan' : 'yolo',
    ...(run.nativeResumeReady && run.launch.agentNativeSessionId ? ['--resume', run.launch.agentNativeSessionId] : []),
    ...images.flatMap(image => ['--attach', image.path])]
  let prepared: ReturnType<typeof prepareZcodePrompt> | undefined
  const { child, text, session, finish, isFinished } = startNativeTurnProcess(run, input, systemPrompt, host, {
    name: definition.name,
    args: text => {
      if (bridge) return ['--eval', WINDOWS_PROMPT_BRIDGE]
      prepared = prepareZcodePrompt(run.launch.command, baseArgs, text)
      return prepared.args
    },
    emptyPrompt: images.length ? 'Inspect the attached images.' : '',
    cleanup: () => prepared?.cleanup(),
    exitError: code => code === 0 ? 'ZCode exited without a final result' : undefined,
  })
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const receive = (line: string) => {
    if (!line.trim() || isFinished() || run.exited || run.stoppedByUser) return
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
  child.stdin?.end(bridge ? JSON.stringify([...baseArgs, '-p', text]) : undefined)
}
