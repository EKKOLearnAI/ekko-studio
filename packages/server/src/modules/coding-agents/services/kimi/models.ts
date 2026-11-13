import { discoverAcpModels } from '../models/acp'
import type { ModelDiscoveryAdapter } from '../models/types'

export const kimiModels: ModelDiscoveryAdapter = {
  source: 'acp', scope: 'configured',
  discover: context => discoverAcpModels(context, ["acp"]),
}
