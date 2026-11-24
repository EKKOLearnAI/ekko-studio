import type { ProviderHttpRequest } from '../../public/provider-http'

type Body = Record<string, any>

interface PromptCacheSettings {
  authProvider: string
  defaults: Body
  ttl: unknown
  capability: unknown
}

/** Hermes treats an absent TTL as 5m and an explicitly null TTL as disabled. */
function cacheMarkersEnabled(ttl: unknown, capability: unknown): boolean {
  return capability !== false && ttl !== null && !['off', 'false', 'disabled', 'no', 'none'].includes(String(ttl).toLowerCase())
}

function markAnthropicPrefix(body: Body, ttl: unknown): Body {
  const marker = ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
  const tools: Body[] = body.tools || []
  const messages: Body[] = body.messages
  // Keep an explicit layout intact, including breakpoints on replayed content.
  if (Array.isArray(body.system) || tools.some(tool => tool.cache_control)
    || messages.some(message => message.content.some((block: Body) => block.cache_control))) return body
  const result = { ...body }
  if (body.system?.trim()) {
    result.system = [{ type: 'text', text: body.system, cache_control: marker }]
  } else if (tools.length) {
    result.tools = [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: marker }]
  }
  // Also cache the growing history. A short lookback at the next turn can then
  // reuse tool calls/results even when the original system prefix was small.
  for (let index = messages.length - 1; index >= 0; index--) {
    const content: Body[] = messages[index].content
    const last = content.findLastIndex(block => block.type === 'text' ? !!block.text?.trim()
      : ['tool_result', 'tool_use', 'image', 'document'].includes(block.type))
    if (last < 0) continue
    result.messages = messages.slice()
    const markedContent = content.slice()
    markedContent[last] = { ...content[last], cache_control: marker }
    result.messages[index] = { ...messages[index], content: markedContent }
    break
  }
  return result
}

/** Restore cache semantics after protocol conversion. Native request bodies bypass this policy. */
export function translatedPromptCacheBody(
  input: ProviderHttpRequest, { authProvider, defaults, ttl, capability }: PromptCacheSettings,
): Body {
  const body = input.body as Body
  const markers = cacheMarkersEnabled(ttl, capability) && !Object.hasOwn(defaults, 'cache_control') && !Object.hasOwn(body, 'cache_control')
  if (input.translatedTo === 'anthropic_messages') {
    const claude = authProvider === 'anthropic' || authProvider === 'claude-oauth' || /(?:^|\/)claude-/i.test(input.model || '')
    return markers && (claude || capability === true) ? markAnthropicPrefix(body, ttl) : body
  }

  const result = { ...body }
  // Hermes can generate these fields even for a strict third-party Chat
  // endpoint. A field in extra_body explicitly opts that endpoint into it.
  if (new URL(input.url).origin !== 'https://api.openai.com') {
    for (const key of ['prompt_cache_key', 'prompt_cache_retention']) {
      if (!Object.hasOwn(defaults, key)) delete result[key]
    }
  }
  const system = body.messages[0]
  if (markers && authProvider === 'qwen-oauth' && system?.role === 'system' && typeof system.content === 'string' && system.content.trim()) {
    result.messages = [{ ...system, content: [{ type: 'text', text: system.content, cache_control: { type: 'ephemeral' } }] }, ...body.messages.slice(1)]
  }
  return result
}
