import { lines, modelId, requireModelOutput } from '../models/text'
import { ModelDiscoveryError, record, text, type ModelDiscoveryAdapter } from '../models/types'

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const grokModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
    try {
      return await context.rpc(['agent', '--no-leader', 'stdio'], async rpc => {
        const initialized = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {},
          _meta: { clientType: 'ekko-studio-models', clientVersion: '1.0.0' } })
        if (initialized?.protocolVersion !== 1) throw new ModelDiscoveryError('unsupported')
        let state = record(initialized?._meta?.modelState)
        // Older native releases publish the catalog in initialize instead of this extension.
        try {
          const response = record(await rpc.request('x.ai/models/list', {}))
          if (Array.isArray(response.result?.availableModels)) state = response.result
        } catch { /* Use the native initialization catalog when the method is absent. */ }
        if (!Array.isArray(state.availableModels)) throw new ModelDiscoveryError('unsupported')
        return { models: state.availableModels.flatMap((raw: unknown) => {
          const model = record(raw), id = text(model.modelId), meta = record(model._meta)
          let efforts: string[] | undefined
          if (meta.supportsReasoningEffort === true) {
            const offered = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.map((option: any) => text(option?.value)) : []
            efforts = EFFORT_ORDER.filter(value => offered.includes(value))
            // This is the native Grok picker fallback for supported models without an enum.
            if (!efforts.length) efforts = ['low', 'medium', 'high', 'xhigh']
          } else if (meta.supportsReasoningEffort === false) efforts = []
          return id ? [{ id, name: text(model.name) || id, isDefault: id === state.currentModelId,
            ...(efforts ? { reasoningEfforts: efforts } : {}),
          }] : []
        }) }
      })
    } catch { /* Keep the text directory available on releases without the native transport. */ }
    const { stdout } = await context.run(['models'])
    const models = lines(stdout).flatMap(line => {
      const match = /^[*-]\s+(\S+)(.*)$/.exec(line), id = match && modelId(match[1])
      return id ? [{ id, name: id, isDefault: /\(default\)/i.test(match![2]) }] : []
    })
    requireModelOutput(models, stdout)
    // Grok advertises its shipped defaults even without an authenticated account.
    return { models, ...(/not authenticated/i.test(stdout) ? { scope: 'builtin' as const } : {}) }
  },
}
