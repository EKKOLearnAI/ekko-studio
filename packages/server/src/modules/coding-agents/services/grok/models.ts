import { lines, modelId, requireModelOutput } from '../models/text'
import type { ModelDiscoveryAdapter } from '../models/types'

export const grokModels: ModelDiscoveryAdapter = {
  source: 'cli', scope: 'available',
  async discover(context) {
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
