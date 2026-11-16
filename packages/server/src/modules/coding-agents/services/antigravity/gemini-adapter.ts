/** Gemini native CLI wire format → canonical Responses → selected provider. */
function geminiSignature(value: string): string {
  // Gemini declares this field as bytes. OpenAI/Studio signatures can contain
  // URL-safe characters, so carry the opaque value in a standard-base64 envelope.
  return Buffer.from(JSON.stringify({ format: 'studio-reasoning-v1', value })).toString('base64')
}

function responseSignature(value: string): string | undefined {
  try {
    const envelope = JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
    if (envelope.format === 'studio-reasoning-v1' && typeof envelope.value === 'string') return envelope.value
  } catch { /* Native Gemini signatures cannot be replayed as Responses data. */ }
  return undefined
}

function geminiImage(part: any): any | undefined {
  const media = part.inlineData || part.fileData
  if (!media) return undefined
  const mime = String(media.mimeType || '').toLowerCase()
  if (!mime.startsWith('image/')) throw Object.assign(new Error('Antigravity scoped input only supports image media'), { status: 400 })
  const url = part.inlineData ? `data:${mime};base64,${media.data}` : String(media.fileUri || '')
  // Never read a CLI-supplied local file or fetch it from this server. Native
  // tools should send inlineData; remote images remain provider-owned URLs.
  if ((part.inlineData && (typeof media.data !== 'string' || !media.data))
    || (!part.inlineData && !/^(https?:\/\/|data:image\/)/i.test(url))) {
    throw Object.assign(new Error('Antigravity image requires inline bytes or an HTTP image URL'), { status: 400 })
  }
  return { type: 'input_image', image_url: url }
}

export function geminiToResponses(body: any): any {
  const input: any[] = []
  const instructions = body.systemInstruction?.parts?.map((part: any) => part.text || '').join('\n')
  let callIndex = 0
  const pending = new Map<string, string[]>()
  for (const content of body.contents || []) {
    const role = content.role === 'model' ? 'assistant' : 'user'
    const parts = Array.isArray(content.parts) ? content.parts : []
    let message: any[] = []
    const flush = () => {
      if (!message.length) return
      input.push({ role, content: message.some(part => part.type === 'input_image')
        ? message : message.map(part => part.text).join('') })
      message = []
    }
    for (const part of parts) {
      const signature = part.thoughtSignature ? responseSignature(part.thoughtSignature) : undefined
      if (signature) input.push({ type: 'reasoning', encrypted_content: signature })
      if (part.thought) continue
      if (typeof part.text === 'string') message.push({ type: 'input_text', text: part.text })
      const image = geminiImage(part)
      if (image) message.push(image)
      if (part.functionCall) {
        flush()
        const call = part.functionCall
        const id = `agy_call_${callIndex++}`
        const ids = pending.get(call.name) || []; ids.push(id); pending.set(call.name, ids)
        input.push({ type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.args || {}) })
      }
      if (part.functionResponse) {
        flush()
        const result = part.functionResponse
        const id = pending.get(result.name)?.shift()
        if (!id) throw Object.assign(new Error(`Unmatched Gemini function response: ${result.name}`), { status: 400 })
        const text = JSON.stringify(result.response ?? {})
        const media = (result.parts || []).map((part: any) => geminiImage(part)
          || (typeof part.text === 'string' ? { type: 'input_text', text: part.text } : undefined)).filter(Boolean)
        input.push({ type: 'function_call_output', call_id: id,
          output: media.length ? [{ type: 'input_text', text }, ...media] : text })
      }
    }
    flush()
  }
  const tools = (body.tools || []).flatMap((tool: any) => (tool.functionDeclarations || []).map((fn: any) => ({
    type: 'function', name: fn.name, description: fn.description,
    parameters: fn.parameters || fn.parametersJsonSchema || { type: 'object', properties: {} },
  })))
  return { input, ...(instructions ? { instructions } : {}), ...(tools.length ? { tools } : {}),
    ...(typeof body.generationConfig?.temperature === 'number' ? { temperature: body.generationConfig.temperature } : {}),
    ...(typeof body.generationConfig?.maxOutputTokens === 'number' ? { max_output_tokens: body.generationConfig.maxOutputTokens } : {}),
    ...(typeof body.generationConfig?.topP === 'number' ? { top_p: body.generationConfig.topP } : {}),
    ...(body.toolConfig?.functionCallingConfig?.mode ? { tool_choice: ({ ANY: 'required', NONE: 'none', AUTO: 'auto' } as Record<string, string>)[body.toolConfig.functionCallingConfig.mode] || 'auto' } : {}),
    stream: false }
}

/** Emit incremental Gemini chunks; never wait for a complete upstream answer. */
export async function* responsesEventsToGemini(events: AsyncIterable<{ type: string; data: any }>): AsyncGenerator<string> {
  const calls = new Map<string, { name: string; arguments: string }>()
  const emitted = new Set<string>()
  const chunk = (parts: any[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }] })}\n\n`
  let completed = false
  for await (const event of events) {
    const data = event.data
    if (event.type === 'response.output_text.delta') yield chunk([{ text: data.delta || '' }])
    if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') yield chunk([{ text: data.delta || '', thought: true }])
    if (event.type === 'response.output_item.added' && data.item?.type === 'function_call') calls.set(data.item.id || String(data.output_index), { name: data.item.name, arguments: data.item.arguments || '' })
    if (event.type === 'response.function_call_arguments.delta') {
      const call = calls.get(data.item_id) || calls.get(String(data.output_index))
      if (call) call.arguments += data.delta || ''
    }
    if (event.type === 'response.output_item.done' && data.item?.type === 'reasoning' && data.item.encrypted_content) yield chunk([{ thought: true, text: '', thoughtSignature: geminiSignature(data.item.encrypted_content) }])
    if (event.type === 'response.output_item.done' && data.item?.type === 'function_call') {
      const id = data.item.id || String(data.output_index)
      if (!emitted.has(id)) {
        const call = calls.get(id)
        const args = JSON.parse(data.item.arguments || call?.arguments || '{}')
        yield chunk([{ functionCall: { name: data.item.name || call?.name, args } }])
        emitted.add(id)
      }
    }
    if (event.type === 'response.completed') {
      const response = data.response || data
      const usage = response.usage || {}
      yield `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: {
        promptTokenCount: usage.input_tokens || 0, candidatesTokenCount: usage.output_tokens || 0, totalTokenCount: usage.total_tokens || 0,
        cachedContentTokenCount: usage.input_tokens_details?.cached_tokens, thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
      } })}\n\n`
      completed = true
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      yield `data: ${JSON.stringify({ error: { code: 502, message: data.response?.error?.message || data.error?.message || 'Provider stream failed', status: 'UNAVAILABLE' } })}\n\n`
      completed = true
    }
  }
  if (!completed) throw new Error('Provider stream ended before completion')
}

export function responsesToGemini(response: any): any {
  if (response.error || response.status === 'failed' || response.status === 'incomplete') {
    throw Object.assign(new Error(response.error?.message || `Provider response ${response.status}`), { status: 502 })
  }
  const parts: any[] = []
  for (const item of response.output || []) {
    if (item.type === 'reasoning' && item.encrypted_content) parts.push({ thought: true, text: '', thoughtSignature: geminiSignature(item.encrypted_content) })
    if (item.type === 'message') for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push({ text: content.text })
    }
    if (item.type === 'function_call') {
      let args = item.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { throw Object.assign(new Error(`Provider returned malformed tool arguments for ${item.name}`), { status: 502 }) }
      }
      parts.push({ functionCall: { name: item.name, args: args || {} } })
    }
  }
  if (!parts.length) throw Object.assign(new Error('Provider returned no text or function calls'), { status: 502 })
  const usage = response.usage
  return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    ...(usage ? { usageMetadata: { promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens, totalTokenCount: usage.total_tokens,
      cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens } } : {}) }
}
