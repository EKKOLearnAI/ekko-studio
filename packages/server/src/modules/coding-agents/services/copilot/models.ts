import { ModelDiscoveryError, record, text, type ModelDiscoveryAdapter } from '../models/types'

export const copilotModels: ModelDiscoveryAdapter = {
  source: 'sdk', scope: 'available',
  // Native Copilot SDK RPC uses vscode-jsonrpc Content-Length framing, not ACP JSONL.
  discover: context => context.rpc(['--headless', '--no-auto-update', '--stdio'], async rpc => {
    const result = record(await rpc.request('models.list'))
    if (!Array.isArray(result.models)) throw new ModelDiscoveryError('unsupported')
    return { models: result.models.flatMap((raw: unknown) => {
      const item = record(raw), id = text(item.id), capabilities = record(item.capabilities), limits = record(capabilities.limits)
      const supports = record(capabilities.supports)
      return id ? [{ id, name: text(item.name) || id, contextWindow: limits.max_context_window_tokens,
        maxOutputTokens: limits.max_output_tokens, inputModalities: supports.vision ? ['text', 'image'] : ['text'] }] : []
    }) }
  }, 'content-length'),
}
