import { ModelDiscoveryError, record, text, type ModelDiscoveryAdapter } from '../models/types'

export const claudeCodeModels: ModelDiscoveryAdapter = {
  source: 'control-protocol', scope: 'available',
  discover: context => context.rpc([
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ], async rpc => {
    const result = record(await rpc.controlInitialize())
    if (!Array.isArray(result.models)) throw new ModelDiscoveryError('unsupported')
    return { models: result.models.flatMap((raw: unknown) => {
      const item = record(raw), id = text(item.value) || text(item.id)
      return id ? [{ id, name: text(item.displayName) || text(item.name) || id, isDefault: id === 'default' }] : []
    }) }
  }),
}
