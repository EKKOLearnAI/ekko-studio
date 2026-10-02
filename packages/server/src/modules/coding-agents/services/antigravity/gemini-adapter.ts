/** Gemini native CLI wire format → canonical Responses → selected provider. */
export function geminiToResponses(body: any): any {
  const input: any[] = []
  const instructions = body.systemInstruction?.parts?.map((part: any) => part.text || '').join('\n')
  let callIndex = 0
  const pending = new Map<string, string[]>()
  for (const content of body.contents || []) {
    const role = content.role === 'model' ? 'assistant' : 'user'
    const parts = Array.isArray(content.parts) ? content.parts : []
    const text = parts.filter((part: any) => typeof part.text === 'string' && !part.thought).map((part: any) => part.text).join('')
    if (text) input.push({ role, content: text })
    for (const part of parts) {
      if (part.functionCall) {
        const call = part.functionCall
        const id = `agy_call_${callIndex++}`
        const ids = pending.get(call.name) || []; ids.push(id); pending.set(call.name, ids)
        input.push({ type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.args || {}) })
      }
      if (part.functionResponse) {
        const result = part.functionResponse
        const id = pending.get(result.name)?.shift()
        if (!id) throw Object.assign(new Error(`Unmatched Gemini function response: ${result.name}`), { status: 400 })
        input.push({ type: 'function_call_output', call_id: id, output: JSON.stringify(result.response ?? {}) })
      }
      if (part.inlineData || part.fileData) throw Object.assign(new Error('Antigravity scoped media input is not supported yet'), { status: 400 })
    }
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
