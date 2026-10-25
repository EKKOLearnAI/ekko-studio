import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { AgentEventQueue } from '@ekko-studio/agent-drivers'
import {
  StudioError,
  mergeAgentContextConfiguration,
  nativeAgentLaunch,
  readAgentImages,
  type AgentContextConfiguration,
  type AgentOutputEvent,
  type AgentRunHandle,
  type AgentRunResult,
  type AgentRuntime,
  type AgentRuntimeContext,
  type ModelGatewayHandle,
  type ProcessHandle,
  type RuntimeCreateInput,
} from '@ekko-studio/plugin-sdk'
import { assertScopedRouting, prepareNative } from './configuration'
import { geminiBridge } from './gemini'
import { nativeParser, type NativeUsage } from './protocol'

type Output = AgentOutputEvent extends infer T ? (T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never) : never
export function createNativeRuntime(input: RuntimeCreateInput, runtime: AgentRuntimeContext): AgentRuntime {
  const config = input.config,
    cwd = String(config.cwd),
    scoped = input.mode === 'scoped'
  if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Antigravity working directory must be absolute')
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Antigravity requires host-managed storage')
  let checkpoint: { nativeSessionId: string; shadowId: string } | undefined
  let shadowId: string = randomUUID()
  if (input.resume !== undefined) {
    const value = input.resume
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['nativeSessionId', 'shadowId'].includes(key)) ||
      typeof value.nativeSessionId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.nativeSessionId)
    )
      throw new StudioError('INVALID_ARGUMENT', 'Invalid Antigravity checkpoint')
    if (typeof value.shadowId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.shadowId))
      throw new StudioError('INVALID_ARGUMENT', 'Invalid Antigravity shadow identity')
    shadowId = value.shadowId
    checkpoint = { nativeSessionId: value.nativeSessionId, shadowId }
  }
  const context = mergeAgentContextConfiguration(config as AgentContextConfiguration)
  let active: AgentRunHandle | undefined,
    disposed = false
  return {
    async run(input, ctx) {
      if (disposed || runtime.signal.aborted || active)
        throw new StudioError('RUNTIME_UNAVAILABLE', 'Antigravity runtime is unavailable or busy')
      const queue = new AgentEventQueue<AgentOutputEvent>()
      let processDisposal: Promise<void> | undefined
      const disposeProcess = () => (processDisposal ??= process?.dispose() || Promise.resolve())
      let sequence = 0,
        cancelled = ctx.signal.aborted,
        process: ProcessHandle | undefined,
        gateway: ModelGatewayHandle | undefined
      let cleanupFailure: unknown
      let bridge: Awaited<ReturnType<typeof geminiBridge>> | undefined,
        imagesDirectory: string | undefined,
        exitTimer: ReturnType<typeof setTimeout> | undefined
      let nativeSessionId = checkpoint?.nativeSessionId,
        nativeModel = typeof config.model === 'string' ? config.model : 'antigravity/unknown',
        terminal: { success: boolean; usage?: NativeUsage } | undefined,
        deadline = false
      const emit = (event: Output) => queue.push({ ...event, producerSequence: ++sequence } as AgentOutputEvent)
      const stop = async () => {
        cancelled = true
        try {
          if (process) await disposeProcess()
        } catch (error) {
          cleanupFailure ??= error
          disposed = true
          throw error
        }
      }
      const abort = () => {
        void stop().catch(() => {})
      }
      ctx.signal.addEventListener('abort', abort, { once: true })
      const result = (async (): Promise<AgentRunResult> => {
        try {
          if (cancelled) return { status: 'cancelled' }
          const text = input.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
          if (/^\/compact(?:\s|$)/.test(text))
            throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native Antigravity compaction is unsupported')
          const images = await readAgentImages(input.content, ctx),
            model = input.model || (config.model as string | undefined)
          if (scoped && !model) throw new StudioError('INVALID_ARGUMENT', 'Scoped Antigravity requires a Studio model')
          if (scoped) await assertScopedRouting(config, runtime)
          gateway = scoped ? await ctx.models.gateway({ model: model!, protocol: 'responses' }) : undefined
          if (images.size && gateway && gateway.images !== true)
            throw new StudioError('CAPABILITY_UNSUPPORTED', 'Selected Studio model does not support images')
          if (gateway) bridge = await geminiBridge(gateway, ctx.signal)
          const effective = mergeAgentContextConfiguration(context, ctx.nativeContext || {})
          effective.systemPrompt = [effective.systemPrompt, ctx.nativeContext?.turnInstructions].filter(Boolean).join('\n\n')
          const prepared = await prepareNative(
            config,
            scoped ? 'scoped' : 'global',
            { ...runtime, runtimeSessionId: shadowId },
            effective,
            bridge,
          )
          const paths: string[] = []
          if (images.size) {
            await mkdir(join(runtime.stateDirectory!, 'images'), { recursive: true })
            imagesDirectory = await mkdtemp(join(runtime.stateDirectory!, 'images', 'turn-'))
            for (const [index, image] of [...images.values()].entries()) {
              const path = join(
                imagesDirectory,
                `${index}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[image.mediaType] || 'img'}`,
              )
              await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
              paths.push(path)
            }
          }
          const prompt = paths.length
            ? [
                text,
                'Before answering, open each attached image with the native image/file viewing tool and inspect its visual content:',
                ...paths.map((path) => JSON.stringify(path)),
              ]
                .filter(Boolean)
                .join('\n')
            : text
          if (cancelled) return { status: 'cancelled' }
          const launch = nativeAgentLaunch('agy', config, runtime)
          // A config override cannot select latest conversation or replace Studio's wire protocol.
          if (
            launch.args.some((arg) =>
              /^(?:--(?:continue|conversation|input-format|output-format|print-timeout|print|prompt|prompt-interactive)|-[pci])(?:=|$)/.test(
                arg,
              ),
            )
          )
            throw new StudioError('INVALID_ARGUMENT', 'Antigravity arguments conflict with managed conversation protocol')
          process = await runtime.processes.spawn({
            command: launch.command,
            cwd,
            args: [
              ...launch.args.filter((arg) => arg !== '--dangerously-skip-permissions'),
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              ...(nativeSessionId ? ['--conversation', nativeSessionId] : []),
              '--dangerously-skip-permissions',
              '--print-timeout',
              '0',
              ...(!scoped && config.model ? ['--model', String(config.model)] : []),
            ],
            env: { ...(config.env as Record<string, string>), ...prepared.env },
          })
          const decoder = new StringDecoder('utf8'),
            parse = nativeParser(!!checkpoint)
          let buffer = ''
          const line = (value: string) => {
            for (const event of parse(value)) {
              if (cancelled) continue
              if (event.type === 'session') {
                if (nativeSessionId && nativeSessionId !== event.id)
                  throw new StudioError('INVALID_ARGUMENT', 'Antigravity did not restore its exact conversation')
                nativeSessionId = event.id
                if (event.model) nativeModel = event.model
              } else if (event.type === 'text') emit({ type: 'message.delta', messageId: 'answer', text: event.text })
              else if (event.type === 'tool')
                emit({
                  type: event.output === undefined ? 'tool.started' : event.failed ? 'tool.failed' : 'tool.completed',
                  callId: event.id,
                  name: event.name,
                  data: event.output === undefined ? event.input : event.output,
                })
              else if (event.type === 'terminal') {
                terminal = event
                if (!scoped && event.usage)
                  emit({
                    type: 'usage.reported',
                    modelCallId: `antigravity-${ctx.scope.runId}`,
                    model: nativeModel,
                    mode: 'final',
                    revision: 1,
                    ...event.usage,
                  })
                exitTimer = setTimeout(() => {
                  deadline = true
                  void process?.stop().catch((error) => {
                    cleanupFailure ??= error
                    disposed = true
                  })
                }, 1500)
              }
            }
          }
          const bytes = Buffer.from(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n')
          const write = (async () => {
            for (let offset = 0; offset < bytes.length; offset += 65536) await process!.write(bytes.subarray(offset, offset + 65536))
            await process!.end()
          })()
          void write.catch(() => {})
          while (true) {
            const batch = await process.read()
            if (batch.truncated) throw new StudioError('RESOURCE_EXHAUSTED', 'Antigravity output was truncated')
            for (const chunk of batch.chunks)
              if (chunk.stream === 'stdout') {
                buffer += decoder.write(Buffer.from(chunk.data))
                if (Buffer.byteLength(buffer) > 4 * 1024 * 1024)
                  throw new StudioError('RESOURCE_EXHAUSTED', 'Antigravity native frame exceeds limit')
                let index: number
                while ((index = buffer.indexOf('\n')) >= 0) {
                  const next = buffer.slice(0, index)
                  buffer = buffer.slice(index + 1)
                  line(next)
                }
              }
            if (batch.exit && !batch.chunks.length) {
              clearTimeout(exitTimer)
              buffer += decoder.end()
              if (buffer.trim()) line(buffer)
              await write
              if (cancelled) return { status: 'cancelled' }
              if (deadline) throw new StudioError('DEADLINE_EXCEEDED', 'Antigravity did not exit after its result')
              if (batch.exit.code !== 0 || batch.exit.signal || !terminal?.success || !nativeSessionId)
                throw new StudioError('RUNTIME_UNAVAILABLE', 'Antigravity did not finish with a successful native result and exit')
              return { status: 'completed', checkpoint: { nativeSessionId, shadowId } }
            }
          }
        } catch (error) {
          if (cancelled) return { status: 'cancelled' }
          queue.fail(error instanceof Error ? error : new Error('Antigravity run failed'))
          throw error
        } finally {
          clearTimeout(exitTimer)
          ctx.signal.removeEventListener('abort', abort)
          // Every owned resource must confirm cleanup before either checkpoint or success advances.
          // A failed confirmation permanently retires this runtime even if a later cleanup succeeds.
          const confirm = async (operation: () => Promise<void>) => {
            try {
              await operation()
            } catch (error) {
              cleanupFailure ??= error
              disposed = true
            }
          }
          try {
            if (process) await confirm(disposeProcess)
            if (bridge) await confirm(() => bridge!.dispose())
            // Aborted Run capabilities are revoked; the host's cancellation barrier owns its gateway.
            if (gateway && !ctx.signal.aborted) await confirm(() => gateway!.dispose())
            if (imagesDirectory) await confirm(() => rm(imagesDirectory!, { recursive: true, force: true }))
            if (cleanupFailure) throw cleanupFailure
          } finally {
            active = undefined
            queue.end()
          }
        }
      })().then((outcome) => {
        if (outcome.status === 'completed') checkpoint = outcome.checkpoint as { nativeSessionId: string; shadowId: string }
        return outcome
      })
      void result.catch(() => {})
      active = {
        events: queue,
        result,
        async cancel() {
          try {
            await stop()
          } catch {
            /* The first cleanup failure is retained and all resources still drain. */
          }
          await result.catch(() => {})
          if (cleanupFailure) throw cleanupFailure
        },
        async respond() {
          throw new StudioError('CAPABILITY_UNSUPPORTED', 'Antigravity has no interactive permission adapter')
        },
      }
      return active
    },
    async dispose() {
      disposed = true
      await active?.cancel('Antigravity runtime disposed')
    },
  }
}
