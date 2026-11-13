import { expect, it } from 'vitest'
import { chatCompletionsToResponses } from '../../packages/server/src/modules/coding-agents/protocol/adapters/chat-completions'
import { responsesToOpenAiChat, responsesToAnthropicMessages } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'

it('preserves text, images and binary files across the Studio Chat Completions proxy', () => {
  const content = [{ type: 'text', text: 'Read these' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    { type: 'file', file: { filename: 'sample.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } }]
  const canonical = chatCompletionsToResponses({ messages: [{ role: 'user', content }] })
  expect(canonical.input[0].content.map((part: any) => part.type)).toEqual(['input_text', 'input_image', 'input_file'])
  const upstream = responsesToOpenAiChat(canonical, { model: 'selected' })
  expect(upstream.messages[0].content).toEqual(content)
})

it('translates inline PDF and text files to Anthropic documents without dropping bytes', () => {
  const canonical = chatCompletionsToResponses({ messages: [{ role: 'user', content: [
    { type: 'file', file: { filename: 'sample.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } },
    { type: 'file', file: { filename: 'notes.txt', file_data: `data:text/plain;base64,${Buffer.from('资料').toString('base64')}` } },
  ] }] })
  expect(responsesToAnthropicMessages(canonical, { model: 'selected' }).messages[0].content).toEqual([
    { type: 'document', title: 'sample.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } },
    { type: 'document', title: 'notes.txt', source: { type: 'text', media_type: 'text/plain', data: '资料' } },
  ])
})

it('reports unsupported cross-provider file references instead of silently removing them', () => {
  const canonical = chatCompletionsToResponses({ messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'upstream-file-id' } }] }] })
  expect(responsesToOpenAiChat(canonical, { model: 'selected' }).messages[0].content).toEqual([{ type: 'file', file: { file_id: 'upstream-file-id' } }])
  expect(() => responsesToAnthropicMessages(canonical, { model: 'selected' })).toThrow('inline PDF or text')
})
