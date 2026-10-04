import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCursorTurnProcess } from '../../packages/server/src/modules/coding-agents/services/cursor/turn-process'
import { startAntigravityTurnProcess } from '../../packages/server/src/modules/coding-agents/services/antigravity/turn-process'
import { geminiToResponses } from '../../packages/server/src/modules/coding-agents/services/antigravity/gemini-adapter'
import { responsesToOpenAiChat, responsesToAnthropicMessages } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('coding agent image and long input transports', () => {
  it.each([['Cursor', startCursorTurnProcess], ['Antigravity', startAntigravityTurnProcess]] as const)('keeps long UTF-8 input on stdin for Windows .cmd launch (%s)', (_name, start) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
      vi.mocked(spawn).mockReturnValue(child as any)
      const input = '--user-text 你好😀\r\n%PATH% & | "quoted" '.repeat(4000).trim()
      const path = 'C:/Users/Test/截图 space.png'
      start({ command: 'C:/Tools/agent.cmd', baseArgs: [], workspaceDir: 'C:/workspace', env: {},
        nativeSessionId: 'native', resume: true, input, images: [{ path, name: '截图.png', mediaType: 'image/png' }],
        onEvent: vi.fn(), onStderr: vi.fn(), onError: vi.fn(), onClose: vi.fn() })
      const [command, args, options] = vi.mocked(spawn).mock.calls.at(-1)!
      expect(command).toBe(process.env.comspec || 'cmd.exe')
      expect(args!.join(' ').length).toBeLessThan(7000)
      expect(args!.join(' ')).not.toContain('--user-text')
      expect(options?.stdio).toEqual(['pipe', 'pipe', 'pipe'])
      expect(child.stdin.writableEnded).toBe(true)
      const sent = child.stdin.read().toString()
      if (start === startCursorTurnProcess) {
        expect(sent).toBe(input)
        expect(args!.join(' ')).toContain('--image')
        expect(args!.join(' ')).toContain(path.replace(/ /g, '^ '))
      } else {
        const message = JSON.parse(sent)
        expect(message).toMatchObject({ event: 'user', message: { content: expect.stringContaining(input) } })
        expect(message.message.content).toContain(JSON.stringify(path))
        expect(message.message.content).toContain('viewing tool')
      }
    } finally { Object.defineProperty(process, 'platform', descriptor) }
  })

  it('sends images without a typed prompt through the Cursor native image flag', () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    vi.mocked(spawn).mockReturnValue(child as any)
    const onError = vi.fn()
    startCursorTurnProcess({ command: 'cursor-agent', baseArgs: [], workspaceDir: '/workspace', env: {}, nativeSessionId: '', resume: false,
      input: '', images: [{ path: '/image.png', name: 'image.png', mediaType: 'image/png' }],
      onEvent: vi.fn(), onStderr: vi.fn(), onError, onClose: vi.fn() })
    expect(vi.mocked(spawn).mock.calls.at(-1)![1]?.slice(-2)).toEqual(['--image', '/image.png'])
    expect(child.stdin.read().toString()).toBe('Inspect the attached images.')
    child.stdin.emit('error', new Error('EPIPE'))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EPIPE' }))
  })

  it('preserves inline images in Gemini user messages and native read-tool results across providers', () => {
    const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }
    const body = geminiToResponses({ contents: [
      { role: 'user', parts: [{ text: 'look' }, image, { text: 'after' }] },
      { role: 'model', parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: '/image.png' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: { result: 'opened' }, parts: [image] } }] },
    ] })
    expect(body.input[0].content).toEqual([{ type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }, { type: 'input_text', text: 'after' }])
    expect(body.input[2].output).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' })
    const target = { model: 'vision', reasoningEffort: '' }
    for (const converted of [body, responsesToOpenAiChat(body, target as any), responsesToAnthropicMessages(body, target as any)]) {
      expect(JSON.stringify(converted).match(/aW1hZ2U=/g)).toHaveLength(2)
      expect(JSON.stringify(converted)).toContain('opened')
    }
  })
  it('does not read local media URLs on the server or silently drop unsupported media', () => {
    expect(() => geminiToResponses({ contents: [{ parts: [{ fileData: { mimeType: 'image/png', fileUri: 'file:///private/image.png' } }] }] })).toThrow('inline bytes')
    expect(() => geminiToResponses({ contents: [{ parts: [{ inlineData: { mimeType: 'video/mp4', data: 'abc' } }] }] })).toThrow('only supports image')
    expect(geminiToResponses({ contents: [{ parts: [{ fileData: { mimeType: 'image/png', fileUri: 'https://example.test/image.png' } }] }] }).input[0].content)
      .toEqual([{ type: 'input_image', image_url: 'https://example.test/image.png' }])
  })
})
