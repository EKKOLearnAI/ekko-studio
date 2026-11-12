import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { childEnvironment, engineStatus, latestVersion, selectedExecutable, installEngine } from './engine.mjs'
import { OmpRpc } from './rpc.mjs'
import { readSettings, saveSettings, maskSecrets, accountKey } from './settings.mjs'

const api = { chat_completions: 'openai-completions', codex_responses: 'openai-responses', anthropic_messages: 'anthropic-messages' }
const inside = (root, file) => { const path = relative(root, file); return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
const modelId = model => `${model.provider}/${model.id}`
const checkpoint = file => ({ schemaVersion: 1, data: { sessionFile: file || null } })
const partsText = parts => parts.filter(part => part.type === 'text').map(part => part.text).join('\n')

async function configuration(directory, models, config, mcpServers) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(directory, 'models.yml'), JSON.stringify(models), { mode: 0o600 }),
    writeFile(join(directory, 'config.yml'), JSON.stringify(config), { mode: 0o600 }),
    writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: mcpServers || {} }), { mode: 0o600 }),
  ])
}
async function start(executable, directory, workspace, config, signal, events, args = []) {
  const rpc = new OmpRpc(executable, ['--mode', 'rpc-ui', '--no-extensions', '--no-skills', '--config', join(directory, 'config.yml'), ...args], {
    cwd: workspace, env: childEnvironment(directory), signal, onEvent: events,
  })
  try { await rpc.initialize(); return rpc } catch (error) { await rpc.close(); throw error }
}
async function catalog(ctx, identity, signal) {
  const settings = await readSettings(ctx, identity), executable = await selectedExecutable(ctx.paths.dataDir, settings.executable)
  if (!executable) return { status: 'not_installed', source: 'omp-rpc', scope: 'available', models: [] }
  const directory = join(ctx.paths.dataDir, 'catalog', accountKey(identity), randomUUID())
  let rpc
  try {
    await configuration(directory, settings.models, settings.config)
    rpc = await start(executable, directory, directory, settings.config, signal, undefined, ['--no-session', ...(settings.defaultModel ? ['--model', settings.defaultModel] : [])])
    const value = await rpc.request('get_available_models', {}, 60000)
    return { status: value.models.length ? 'ready' : 'auth_required', source: 'omp-rpc', scope: 'available',
      models: value.models.map(model => ({ id: modelId(model), name: model.name || model.id, provider: model.provider,
        isDefault: modelId(model) === settings.defaultModel, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens })),
      ...(!value.models.length ? { message: 'Configure OMP models and credentials in Settings.' } : {}) }
  } finally { await rpc?.close(); await rm(directory, { recursive: true, force: true }) }
}
export function apply(ctx) {
  const dataDir = ctx.paths.dataDir
  ctx.rpc.register('get-settings', async (_input, run) => ({ ...maskSecrets(await readSettings(ctx, run.identity)),
    status: await engineStatus(dataDir, (await readSettings(ctx, run.identity)).executable, run.signal) }))
  ctx.rpc.register('save-settings', (input, run) => saveSettings(ctx, run.identity, input))
  const registration = ctx.agents.register({
    id: 'omp', name: 'Oh My Pi', vendor: 'Stencil Labs', agentApiVersion: 1,
    description: 'OMP coding Agent with native global models and Studio scoped models.',
    getStatus: async run => { await mkdir(dataDir, { recursive: true, mode: 0o700 }); return engineStatus(dataDir, (await readSettings(ctx, run.identity)).executable, run.signal) },
    management: {
      settings: () => ({ viewId: 'settings' }),
      checkUpdate: async run => {
        const settings = await readSettings(ctx, run.identity), status = await engineStatus(dataDir, settings.executable, run.signal)
        if (settings.executable) return { currentVersion: status.version, latestVersion: status.version, updateAvailable: false, message: 'This executable is managed outside Studio.' }
        const latest = await latestVersion(run.signal)
        return { currentVersion: status.version, latestVersion: latest, updateAvailable: !status.installed || status.version !== latest }
      },
      upgrade: async (input, run) => {
        if ((await readSettings(ctx, run.identity)).executable) throw new Error('Clear the custom executable to use Studio-managed OMP updates')
        return installEngine(dataDir, input.version, run.signal, run.progress)
      },
    },
    modes: { global: { listModels: run => catalog(ctx, run.identity, run.signal) }, scoped: { protocols: Object.keys(api) } },
    capabilities: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], streaming: true, resume: true },
    runtime: {
      async createSession(session) {
        let nativeFile = session.resumeState?.schemaVersion === 1 ? session.resumeState.data?.sessionFile : null
        const pointer = join(session.paths.runtimeDir, 'native-session.json')
        if (!nativeFile) { try { nativeFile = JSON.parse(await readFile(pointer, 'utf8')).sessionFile } catch (error) { if (error.code !== 'ENOENT') throw error } }
        if (nativeFile && (typeof nativeFile !== 'string' || isAbsolute(nativeFile) || !inside(session.paths.runtimeDir, join(session.paths.runtimeDir, nativeFile)))) throw new Error('Invalid OMP session checkpoint')
        if (nativeFile) { try { await access(join(session.paths.runtimeDir, nativeFile)) } catch (error) { if (error.code === 'ENOENT') nativeFile = null; else throw error } }
        return {
          checkpoint: async () => checkpoint(nativeFile),
          dispose() {},
          async run(input, run) {
            const settings = await readSettings(ctx, run.identity), executable = await selectedExecutable(dataDir, settings.executable)
            if (!executable) throw new Error('OMP is not installed. Open Agent management and check updates to install it.')
            const directory = join(run.paths.runtimeDir, 'turns', run.identity.runId), nativeDirectory = join(run.paths.runtimeDir, 'sessions')
            let models = settings.models, config = { ...settings.config }, selected = run.mode === 'scoped' ? `studio/${run.model.model}` : run.model.model || settings.defaultModel
            if (run.mode === 'scoped') {
              models = { providers: { studio: { api: api[run.model.apiMode], baseUrl: run.model.baseUrl, apiKey: run.model.token,
                models: [{ id: run.model.model, name: run.model.model, input: ['text', 'image'], reasoning: !!run.model.reasoningEffort,
                  ...(run.model.contextWindow ? { contextWindow: run.model.contextWindow } : {}), ...(run.model.outputLimit ? { maxTokens: run.model.outputLimit } : {}) }] } } }
              config = { ...config, modelRoles: { default: selected, smol: selected, slow: selected, plan: selected } }
            }
            let rpc
            try {
              await configuration(directory, models, config, run.mcpServers)
              await mkdir(nativeDirectory, { recursive: true, mode: 0o700 })
              const history = nativeFile ? '' : (await Promise.all(input.history.map(async message => `${message.role}: ${(await Promise.all(message.content.map(async part => part.type === 'text' ? part.text : `${part.type}: ${(await run.attachments.resolve(part.assetId)).localPath}`))).join('\n')}`))).join('\n')
              const instructions = [...input.instructions.map(item => item.text), ...(history ? [`Previous Studio conversation:\n${history}`] : [])].join('\n\n')
              const promptPath = join(directory, 'instructions.md')
              await writeFile(promptPath, instructions, { mode: 0o600 })
              const chunks = [], images = []
              for (const part of input.input) {
                if (part.type === 'text') chunks.push(part.text)
                else if (part.type === 'image') images.push({ type: 'image', mimeType: part.mediaType, data: Buffer.from(await run.attachments.read(part.assetId)).toString('base64') })
                else {
                  const asset = await run.attachments.resolve(part.assetId)
                  chunks.push(`Attached file ${JSON.stringify(part.name)} is available at ${JSON.stringify(asset.localPath)}. Read this file with your native tools before answering about its contents.`)
                }
              }
              let finalText = '', stopReason = 'stop', tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null, isEstimated: false }, sawUsage = false
              const assistant = new Map()
              const events = async (frame, transport) => {
                if (frame.type === 'message_update') {
                  const event = frame.assistantMessageEvent
                  if (event?.type === 'text_delta') await run.events.emit({ type: 'text.delta', text: event.delta })
                  else if (event?.type === 'thinking_delta') await run.events.emit({ type: 'reasoning.summary.delta', text: event.delta })
                } else if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
                  const message = frame.message
                  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage || `OMP turn ${message.stopReason}`)
                  finalText = partsText(message.content || []); stopReason = message.stopReason === 'length' ? 'length' : 'stop'
                  assistant.set(frame.messageId || randomUUID(), message)
                } else if (frame.type === 'tool_execution_start') await run.events.emit({ type: 'tool.started', callId: frame.toolCallId, name: frame.toolName, input: frame.args || {} })
                else if (frame.type === 'tool_execution_end') {
                  const encoded = JSON.stringify(frame.result ?? null)
                  await run.events.emit(frame.isError ? { type: 'tool.failed', callId: frame.toolCallId, error: encoded.slice(0, 100000) }
                    : { type: 'tool.completed', callId: frame.toolCallId, result: encoded.length > 100000 ? { truncated: true, text: encoded.slice(0, 100000) } : frame.result ?? null })
                }
                else if (frame.type.endsWith?.('compaction_start')) await run.events.emit({ type: 'status', phase: 'compressing' })
                else if (frame.type === 'extension_ui_request') {
                  if (frame.method === 'confirm') {
                    const result = await run.interactions.approve({ operationId: frame.id, title: frame.title || 'OMP', details: frame.message || '' })
                    transport.send({ type: 'extension_ui_response', id: frame.id, confirmed: result.outcome === 'approved' })
                  } else if (['select', 'input', 'editor'].includes(frame.method)) {
                    if (frame.secret) { transport.send({ type: 'extension_ui_response', id: frame.id, cancelled: true }); return }
                    const result = await run.interactions.clarify({ question: frame.title || frame.message || 'OMP', ...(frame.options ? { choices: frame.options } : {}) })
                    transport.send({ type: 'extension_ui_response', id: frame.id, ...(result.outcome === 'answered' ? { value: result.text } : { cancelled: true }) })
                  } else if (['notify', 'setStatus'].includes(frame.method)) await run.events.emit({ type: 'status', phase: 'working', message: frame.message || frame.text || '' })
                  else if (frame.method === 'form') transport.send({ type: 'extension_ui_response', id: frame.id, cancelled: true })
                }
              }
              const args = ['--session-dir', nativeDirectory, '--append-system-prompt', promptPath, ...(selected ? ['--model', selected] : []), ...(nativeFile ? ['--resume', join(run.paths.runtimeDir, nativeFile)] : [])]
              rpc = await start(executable, directory, run.paths.workspaceDir, config, run.signal, events, args)
              run.resources.add(() => rpc.close())
              const state = await rpc.request('get_state')
              if (state.sessionFile && inside(run.paths.runtimeDir, state.sessionFile)) {
                nativeFile = relative(run.paths.runtimeDir, state.sessionFile)
                await writeFile(pointer, JSON.stringify({ sessionFile: nativeFile }), { mode: 0o600 })
              }
              await rpc.request('set_cache_warming', { mode: 'off' })
              if (run.model.reasoningEffort) await rpc.request('set_thinking_level', { level: ['none', 'disabled'].includes(run.model.reasoningEffort) ? 'off' : run.model.reasoningEffort })
              await rpc.prompt(chunks.join('\n\n'), images)
              await rpc.queue
              if (rpc.failure) throw rpc.failure
              for (const message of assistant.values()) {
                if (!message.usage) continue
                sawUsage = true; tokens.inputTokens += message.usage.input || 0; tokens.outputTokens += message.usage.output || 0
                tokens.cacheReadTokens += message.usage.cacheRead || 0
                if (message.usage.cost?.total > 0) tokens.costUsd = (tokens.costUsd || 0) + message.usage.cost.total
              }
              return { content: [{ type: 'text', text: finalText }], finishReason: stopReason, checkpoint: checkpoint(nativeFile), ...(sawUsage ? { usage: tokens } : {}) }
            } catch (error) {
              throw new Error(run.mode === 'scoped' ? String(error.message).split(run.model.token).join('[redacted]') : String(error.message))
            } finally { await rpc?.close(); await rm(directory, { recursive: true, force: true }) }
          },
        }
      },
    },
  })
  return () => registration.dispose()
}
