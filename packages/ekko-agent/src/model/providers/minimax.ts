import type { ModelProviderConfig, ModelRequest } from '../types'

/** Direct API policy only; gateways and saved legacy models keep their dialect. */
export function minimaxThinkingParameters(
  config: ModelProviderConfig,
  request: ModelRequest,
  protocol: 'anthropic' | 'openai',
) {
  let host: string
  try { host = new URL(config.baseUrl || '').hostname } catch { return {} }
  if (!['api.minimax.io', 'api.minimaxi.com'].includes(host)) return {}
  const model = request.model ?? config.defaultModel
  if (model === 'MiniMax-M3.1-Flash') {
    const effort = request.reasoningEffort ?? 'max'
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      throw new Error('MiniMax-M3.1-Flash requires reasoning effort low, medium, high, xhigh, or max.')
    }
    return {
      thinking: { type: 'adaptive' },
      ...(protocol === 'anthropic' ? { output_config: { effort } } : { reasoning_effort: effort }),
    }
  }
  if (model === 'MiniMax-M3' && request.reasoningEffort !== undefined) {
    return { thinking: { type: request.reasoningEffort === 'none' ? 'disabled' : 'adaptive' } }
  }
  return {}
}
