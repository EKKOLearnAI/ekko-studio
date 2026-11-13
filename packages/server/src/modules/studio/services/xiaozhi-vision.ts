import { resolveDashScopeKey, OMNI_ANALYSIS_BASE_URL, OMNI_ANALYSIS_DEFAULT_MODEL } from './speech-practice-omni'

/** Analyze the actual saved camera frame; never infer a scene from its filename. */
export async function describeXiaozhiFrame(jpeg: Buffer, question: string, deps: {
  fetchImpl?: typeof fetch
  resolveKey?: () => Promise<string | null>
} = {}) {
  const key = await (deps.resolveKey || resolveDashScopeKey)()
  if (!key) throw new Error('Camera vision API key is not configured')
  const response = await (deps.fetchImpl || fetch)(`${OMNI_ANALYSIS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OMNI_ANALYSIS_DEFAULT_MODEL, stream: true, modalities: ['text'],
      messages: [{ role: 'user', content: [
        { type: 'text', text: `请根据这张实际摄像头照片回答：${question.slice(0, 1000)}。回答简短，适合语音播报；看不清的内容明确说明，不要猜测。` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      ] }],
    }),
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  })
  if (!response.ok || !response.body) throw new Error(`Camera vision request failed (HTTP ${response.status})`)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', answer = ''
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    const event = JSON.parse(data)
    if (event.error) throw new Error('Camera vision model returned an error')
    const text = event.choices?.[0]?.delta?.content
    if (typeof text === 'string') answer += text
    else if (Array.isArray(text)) answer += text.map(part => part.text || '').join('')
    if (answer.length > 6000) throw new Error('Camera vision answer exceeded the limit')
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split('\n'); pending = lines.pop() || ''
      for (const line of lines) consume(line.trim())
      if (pending.length > 128_000) throw new Error('Invalid camera vision response')
      if (done) { consume(pending.trim()); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  if (!answer.trim()) throw new Error('Camera vision model returned no description')
  return answer.trim()
}
