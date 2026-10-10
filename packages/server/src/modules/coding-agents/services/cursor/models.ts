import { lines, modelId, requireModelOutput } from '../models/text'
import type { ModelDiscoveryAdapter } from '../models/types'

export const cursorModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
    const { stdout } = await context.run(['models'])
    const models = lines(stdout).flatMap(line => {
      const match = /^(\S+)\s+-\s+(.+)$/.exec(line), id = match && modelId(match[1])
      return id ? [{ id, name: match![2].replace(/\s*\((?:current|default|current, default)\)$/, ''), isDefault: /\bdefault\)/i.test(match![2]) }] : []
    })
    requireModelOutput(models, stdout)
    return { models }
  },
}
