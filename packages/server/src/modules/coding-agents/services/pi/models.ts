import { lines, modelId, requireModelOutput, tokenCount } from '../models/text'
import type { ModelDiscoveryAdapter } from '../models/types'

export const piModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
    const { stdout } = await context.run(['--list-models'])
    const models = lines(stdout).flatMap(line => {
      const [provider, model, window, output, , images] = line.split(/\s+/)
      if (!modelId(provider) || !modelId(model || '') || !tokenCount(window || '') || !tokenCount(output || '')) return []
      return [{ id: `${provider}/${model}`, name: model, provider, contextWindow: tokenCount(window), maxOutputTokens: tokenCount(output),
        inputModalities: images === 'yes' ? ['text', 'image'] : ['text'],
      }]
    })
    requireModelOutput(models, stdout)
    return { models }
  },
}
