/** Gemini native CLI wire format → canonical Responses → selected provider. */
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
    stream: false }
}

export function responsesToGemini(response: any): any {
  if (response.error || response.status === 'failed' || response.status === 'incomplete') {
    throw Object.assign(new Error(response.error?.message || `Provider response ${response.status}`), { status: 502 })
  }
  const parts: any[] = []
  for (const item of response.output || []) {
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
