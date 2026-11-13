import { lines, modelId, requireModelOutput } from '../models/text'
import type { ModelDiscoveryAdapter } from '../models/types'

export const openCodeModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'configured',
  async discover(context) {
    const { stdout } = await context.run(['models'])
    const models = lines(stdout).flatMap(line => {
      const id = modelId(line), separator = id?.indexOf('/') ?? -1
      return id && separator > 0 ? [{ id, name: id.slice(separator + 1), provider: id.slice(0, separator) }] : []
    })
    // A fresh OpenCode installation can have no connected providers.
    if (stdout.trim()) requireModelOutput(models, stdout)
    return { models }
  },
}
