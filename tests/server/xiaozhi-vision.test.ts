import { expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/services/speech-practice-omni', () => ({
  resolveDashScopeKey: async () => 'private-key',
  OMNI_ANALYSIS_BASE_URL: 'https://vision.example/v1', OMNI_ANALYSIS_DEFAULT_MODEL: 'vision-model',
}))
import { describeXiaozhiFrame } from '../../packages/server/src/modules/studio/services/xiaozhi-vision'

it('sends image pixels and the question to the multimodal model and decodes split SSE text', async () => {
  const encoded = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"红色物体"}}]}\n\ndata: [DONE]\n')
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7))
    controller.close()
  } })
  const fetchImpl = vi.fn().mockResolvedValue(new Response(stream))
  const image = Buffer.from('real JPEG bytes')
  expect(await describeXiaozhiFrame(image, '这是什么？', { fetchImpl })).toBe('红色物体')
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
  expect(body.messages[0].content[1].image_url.url).toBe(`data:image/jpeg;base64,${image.toString('base64')}`)
  expect(body.messages[0].content[0].text).toContain('这是什么？')
})
it('reports model failure and missing credentials instead of inventing a scene', async () => {
  await expect(describeXiaozhiFrame(Buffer.alloc(1), '看图', { resolveKey: async () => null })).rejects.toThrow('not configured')
  await expect(describeXiaozhiFrame(Buffer.alloc(1), '看图', { fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 503 })) })).rejects.toThrow('503')
})
