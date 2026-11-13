const version = '1.0.0'

export function apply(ctx) {
  const settings = identity => ctx.state.plugin.namespace('settings', String(identity.userId), identity.profile)
  ctx.extensions.rpc.register('get-settings', async (_input, run) => ({ prefix: await settings(run.identity).get('prefix') ?? 'Echo' }))
  ctx.extensions.rpc.register('save-settings', async (input, run) => {
    if (typeof input?.prefix !== 'string' || input.prefix.length > 100) throw new Error('Prefix must contain at most 100 characters')
    await settings(run.identity).set('prefix', input.prefix)
    return { ok: true }
  })
  const registration = ctx.extensions.agents.register({
    id: 'assistant', name: 'Custom Agent', vendor: 'Example Team', agentApiVersion: 1,
    getStatus: async () => ({ installed: true, version, source: 'plugin' }),
    management: {
      settings: () => ({ viewId: 'settings' }),
      checkUpdate: async () => ({ currentVersion: version, latestVersion: version, updateAvailable: false }),
    },
    modes: {
      global: { listModels: async () => ({ status: 'ready', source: 'sdk', scope: 'builtin', models: [{ id: 'local-echo', name: 'Local echo', isDefault: true }] }) },
      scoped: { protocols: ['chat_completions'] },
    },
    features: { surfaces: ['chat', 'group-chat', 'workflow', 'api'], streaming: true, resume: false },
    runtime: {
      createSession() {
        return {
          async run(input, run) {
            run.signal.throwIfAborted()
            let text
            if (run.mode === 'global') {
              const prefix = await settings(run.identity).get('prefix') ?? 'Echo'
              const parts = []
              for (const part of input.input) {
                if (part.type === 'text') parts.push(part.text)
                else { const bytes = await run.attachments.read(part.assetId); parts.push(`${part.name}: ${bytes.byteLength} bytes`) }
              }
              text = `${prefix}: ${parts.join('\n')}`
            } else {
              const convert = async parts => Promise.all(parts.map(async part => {
                if (part.type === 'text') return { type: 'text', text: part.text }
                const bytes = await run.attachments.read(part.assetId)
                const data = `data:${part.mediaType};base64,${Buffer.from(bytes).toString('base64')}`
                return part.type === 'image' ? { type: 'image_url', image_url: { url: data } }
                  : { type: 'file', file: { filename: part.name, file_data: data } }
              }))
              const messages = [
                ...input.instructions.map(instruction => ({ role: 'system', content: instruction.text })),
                ...await Promise.all(input.history.map(async message => ({ role: message.role, content: await convert(message.content) }))),
                { role: 'user', content: await convert(input.input) },
              ]
              const response = await fetch(`${run.model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST', signal: run.signal,
                headers: { Authorization: `Bearer ${run.model.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: run.model.model, messages, stream: false }),
              })
              if (!response.ok) throw new Error(`Studio model proxy returned ${response.status}`)
              const result = await response.json()
              text = result.choices?.[0]?.message?.content
              if (typeof text !== 'string') throw new Error('Model returned no assistant text')
            }
            await run.output.emit({ type: 'text.delta', text })
            return { content: [{ type: 'text', text }], finishReason: 'stop' }
          },
          dispose() {},
        }
      },
    },
  })
  return () => registration.dispose()
}
