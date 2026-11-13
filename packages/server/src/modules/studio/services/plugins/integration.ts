import { getPluginManager } from './host'
import { json } from './schema'
import type { PluginHook, PluginIdentity } from '../../contracts/plugins'

/** Structural adapter: the Studio host does not import a concrete agent runtime. */
export function pluginRunHooks(identity: PluginIdentity, signal?: AbortSignal) {
  const transform = async <T>(hook: PluginHook, value: T): Promise<T> => {
    if (!getPluginManager().hasHooks(identity, hook)) return value
    const result = await getPluginManager().transform(identity, hook, json(value), signal)
    if (result.deny) throw new Error(result.deny)
    return (result.value === undefined ? value : result.value) as T
  }
  const messages = async <T extends { role: string }>(hook: PluginHook, value: T[]): Promise<T[]> => {
    if (!getPluginManager().hasHooks(identity, hook)) return value
    const result = await transform(hook, value)
    if (!Array.isArray(result) || result.some(item => !item || !['system', 'user', 'assistant', 'tool'].includes(item.role))) throw new Error('Plugin returned invalid messages')
    return result
  }
  return {
    transformInput: <T extends { role: string }>(value: T[]) => messages('input.transform', value),
    transformContext: <T extends { role: string }>(value: T[]) => messages('context.transform', value),
    async beforeTool(name: string, input: Record<string, unknown>) {
      const result = await transform('tool.before', { name, input })
      if (result.name !== name || !result.input || typeof result.input !== 'object' || Array.isArray(result.input)) throw new Error('Plugin may transform tool arguments but cannot replace the tool')
      return result.input
    },
    async afterTool<T extends { ok: boolean; content: string }>(name: string, input: Record<string, unknown>, result: T): Promise<T> {
      const next = await transform('tool.after', { name, input, result })
      if (!next.result || typeof next.result.ok !== 'boolean' || typeof next.result.content !== 'string') throw new Error('Plugin returned an invalid tool result')
      return next.result
    },
  }
}
