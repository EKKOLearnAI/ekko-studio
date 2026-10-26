import { lines, modelId, requireModelOutput } from '../models/text'
import { discoveryError, type ModelDiscoveryAdapter } from '../models/types'

export const qoderModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
    const { stdout } = await context.run(['--list-models'])
    const table = lines(stdout)
    const header = table.indexOf('MODEL')
    if (header < 0) throw discoveryError(stdout)
    const models = table.slice(header + 1).flatMap(line => {
      const match = /^(\S+)(?:\s+\((default|current)\))?$/.exec(line), id = match && modelId(match[1])
      return id && id !== 'MODEL' ? [{ id, name: id, ...(match![2] === 'default' ? { isDefault: true } : {}) }] : []
    })
    requireModelOutput(models, stdout)
    return { models }
  },
}
