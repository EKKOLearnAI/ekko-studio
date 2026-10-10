import { lines, modelId, requireModelOutput } from '../models/text'
import type { ModelDiscoveryAdapter } from '../models/types'

export const antigravityModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
    const { stdout } = await context.run(['models'])
    const models = lines(stdout).flatMap(line => {
      const match = /^(\S+)\s+(.+)$/.exec(line), id = match && modelId(match[1])
      return id && id !== 'Model' && id !== 'ID' ? [{ id, name: match![2] }] : []
    })
    requireModelOutput(models, stdout)
    return { models }
  },
}
