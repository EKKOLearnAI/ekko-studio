/** ChatGPT subscription inference differs from the public OpenAI API. */
export function withoutUnsupportedReasoning(body: Record<string, any>, reasoning: boolean): Record<string, any> {
  if (reasoning) return body
  const result = { ...body }
  for (const key of ['reasoning', 'reasoning_effort', 'thinking']) delete result[key]
  return result
}

export function isCodexInferenceRequest(input: { provider?: string; url: string }): boolean {
  if (input.provider === 'openai-codex') return true
  try { return /\/backend-api\/codex\/(?:v1\/)?responses\/?$/.test(new URL(input.url).pathname) }
  catch { return false }
}

export function codexInferenceBody(body: unknown): Record<string, any> {
  const request = { ...(body as Record<string, any>) }
  // Match the native Codex ModelClient: this backend is streaming-only and
  // does not accept sampling controls or max_output_tokens.
  for (const key of ['max_output_tokens', 'max_tokens', 'temperature', 'top_p']) delete request[key]
  return {
    ...request,
    input: typeof request.input === 'string'
      ? [{ role: 'user', content: [{ type: 'input_text', text: request.input }] }]
      : request.input,
    instructions: typeof request.instructions === 'string' ? request.instructions : '',
    include: [...new Set([...(Array.isArray(request.include) ? request.include : []), 'reasoning.encrypted_content'])],
    stream: true,
    store: false,
  }
}
