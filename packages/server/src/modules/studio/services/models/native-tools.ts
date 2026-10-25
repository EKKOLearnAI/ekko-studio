import { createHash } from 'node:crypto'
import { StudioError } from '../../contracts/plugins'

export const unsupportedNative = (feature: string): never => { throw new StudioError('CAPABILITY_UNSUPPORTED', `Cross-protocol models do not support ${feature}`) }
const invalid = (): never => { throw new StudioError('INVALID_ARGUMENT', 'Invalid cross-protocol model request') }
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: any): string => typeof value === 'string' ? value : invalid()

/** Namespaces are encoded without collisions and restored in every returned call. */
export class NativeTools {
  readonly tools: any[] = []
  readonly names = new Map<string, { name: string; namespace?: string }>()
  private identities = new Map<string, string>()
  constructor(tools: any[] = []) {
    if (!Array.isArray(tools) || tools.length > 256) invalid()
    const add = (tool: any, namespace?: string) => {
      if (!object(tool)) invalid()
      if (tool.type !== 'function') unsupportedNative('server tools or custom tool grammars')
      const name = string(tool.name), identity = JSON.stringify([namespace ?? null, name])
      if (!name || this.identities.has(identity) || this.tools.length >= 256) invalid()
      // Hash all names so a plain tool cannot collide with a flattened namespace.
      const alias = `studio_${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
      this.identities.set(identity, alias)
      this.names.set(alias, { name, ...(namespace ? { namespace } : {}) })
      if (tool.strict || tool.defer_loading || tool.async || tool.allowed_callers?.some((v: string) => v !== 'direct')) unsupportedNative('deferred or programmatic tools')
      this.tools.push({ ...tool, name: alias, description: [namespace ? `${namespace}.${name}` : name, tool.description].filter(Boolean).join(': ') })
    }
    for (const tool of tools) {
      if (tool?.type === 'namespace') {
        const namespace = string(tool.name)
        if (!namespace || !Array.isArray(tool.tools)) invalid()
        for (const nested of tool.tools) add(nested, namespace)
      } else add(tool)
    }
  }
  input(item: any): any {
    if (item?.type !== 'function_call') return item
    const identity = JSON.stringify([item.namespace ?? null, item.name])
    // Historical tools may have been removed from this turn's catalog.
    const name = this.identities.get(identity) ?? `studio_${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
    return { ...item, name }
  }
  forcedName(choice: any): string {
    if (!object(choice) || Object.keys(choice).some(key => !['type', 'name', 'namespace'].includes(key))
      || choice.type !== 'function' || typeof choice.name !== 'string'
      || (choice.namespace !== undefined && typeof choice.namespace !== 'string')) invalid()
    const name = this.identities.get(JSON.stringify([choice.namespace ?? null, choice.name]))
    return name ?? invalid()
  }
  output(item: any): any {
    if (item?.type !== 'function_call') return item
    const original = this.names.get(item.name)
    if (!original) throw new StudioError('RUNTIME_UNAVAILABLE', 'Provider returned an undeclared tool')
    return { ...item, ...original }
  }
}

/** Reject content the shared legacy codecs cannot represent instead of silently dropping it. */
export function validateTranslationInput(protocol: 'responses' | 'anthropic', body: Record<string, any>): void {
  const content = (value: any, types: string[]) => {
    if (typeof value === 'string') return
    if (!Array.isArray(value)) invalid()
    for (const part of value) if (typeof part !== 'string' && !types.includes(part?.type)) unsupportedNative('this content block')
  }
  if (protocol === 'responses') {
    if (typeof body.input !== 'string' && !Array.isArray(body.input)) invalid()
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (!object(item)) invalid()
      if (item.role) content(item.content, ['input_text', 'output_text', 'text', 'input_image'])
      else if (item.type === 'function_call_output') content(item.output, ['input_text', 'text', 'input_image'])
      else if (!['function_call', 'reasoning'].includes(item.type)) unsupportedNative('this Responses input item')
    }
  } else {
    if (!Array.isArray(body.messages) || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) invalid()
    for (const field of ['stop_sequences', 'container', 'mcp_servers', 'context_management', 'output_config', 'top_k', 'top_p']) {
      if (body[field] != null) unsupportedNative(field)
    }
    if (body.system != null) content(body.system, ['text'])
    if (body.tools != null && !Array.isArray(body.tools)) invalid()
    for (const message of body.messages) {
      if (!object(message) || !['user', 'assistant'].includes(message.role)) invalid()
      content(message.content, ['text', 'image', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'])
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') content(block.content ?? '', ['text', 'image'])
      }
    }
  }
}
