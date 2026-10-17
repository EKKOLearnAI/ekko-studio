import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAcpTurn } from '../../packages/server/src/modules/coding-agents/protocol/acp/turn'
import { acpMcpServers, applyNativeAcpUpdate } from '../../packages/server/src/modules/coding-agents/protocol/acp/events'
import { applyZcodeEvent } from '../../packages/server/src/modules/coding-agents/services/zcode/event-adapter'

const turns: NativeAcpTurn[] = []
afterEach(() => { for (const turn of turns.splice(0)) turn.dispose() })

function connection(options: { image?: boolean; load?: boolean; resume?: boolean; error?: boolean; hold?: boolean; permissionRequired?: boolean; configOptions?: any[] } = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
  const sent: any[] = [], update = vi.fn(), session = vi.fn()
  const receive = (message: object) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString())
    sent.push(message)
    if (!message.method || message.id === undefined || (options.hold && message.method === 'session/prompt')) return
    if (message.method === 'session/load') receive({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } } } })
    const result = message.method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: options.image }, loadSession: options.load, sessionCapabilities: options.resume ? { resume: {} } : {} } }
      : message.method === 'session/new' ? { sessionId: 'native', configOptions: options.configOptions }
      : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
    queueMicrotask(() => receive({ id: message.id, ...(options.error && message.method === 'session/load'
      ? { error: { code: -32000, message: 'Session missing' } } : { result }) }))
  })
  const turn = new NativeAcpTurn(child as unknown as ChildProcess, { update, session, permissionRequired: options.permissionRequired })
  turns.push(turn)
  return { child, turn, sent, receive, update, session }
}

describe('native ACP session transport', () => {
  it.each(['high', 'off', 'on'])('applies native model and thought selector %s before sending the prompt', async reasoningEffort => {
    const { turn, sent } = connection({ configOptions: [{ id: 'native-model', category: 'model' }, { id: 'effort', category: 'thought_level' }] })
    await turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: [], model: 'exact/native-model', reasoningEffort })
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
    expect(sent[2].params).toEqual({ sessionId: 'native', configId: 'native-model', value: 'exact/native-model' })
    expect(sent[3].params).toEqual({ sessionId: 'native', configId: 'effort', value: reasoningEffort })
  })

  it('uses the legacy ACP model method when the CLI has no config selector', async () => {
    const { turn, sent } = connection()
    await turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: [], model: 'legacy-model' })
    expect(sent[2]).toMatchObject({ method: 'session/set_model', params: { sessionId: 'native', modelId: 'legacy-model' } })
  })
  it('sends exact image bytes and long Unicode text over stdin after capability negotiation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-acp-image-'))
    try {
      const path = join(root, '截图 space.png'), bytes = Buffer.from([0, 255, 1, 128])
      writeFileSync(path, bytes)
      const { turn, sent } = connection({ image: true })
      const text = '中文😀\r\n$HOME & "%PATH%" '.repeat(4000)
      await turn.prompt({ cwd: '/workspace', text, images: [{ path, name: '截图.png', mediaType: 'image/png' }], mcpServers: [] })
      expect(sent.at(-1).params.prompt).toEqual([{ type: 'text', text },
        { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }])
      const onlyImages = connection({ image: true })
      await onlyImages.turn.prompt({ cwd: '/workspace', text: '', images: [{ path, name: 'photo.jpg', mediaType: 'image/jpg' }], mcpServers: [] })
      expect(onlyImages.sent.at(-1).params.prompt).toEqual([{ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects image input before creating a session when the CLI does not advertise it', async () => {
    const { turn, sent } = connection()
    await expect(turn.prompt({ cwd: '/workspace', text: 'look', images: [{ path: '/not-read.png', name: 'x', mediaType: 'image/png' }], mcpServers: [] })).rejects.toThrow('ACP image input support')
    expect(sent.map(message => message.method)).toEqual(['initialize'])
  })
  it('negotiates and forwards scoped managed MCP env without vendor-specific calls', async () => {
    const { turn, sent, child } = connection()
    const servers = acpMcpServers({ enabled: { command: 'node', args: ['mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }, disabled: { command: 'skip', enabled: false } })
    await expect(turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: servers })).resolves.toBe('end_turn')
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(sent[1].params.mcpServers).toEqual([{ name: 'enabled', command: 'node', args: ['mcp.mjs'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }])
    expect(child.stdin.writableEnded).toBe(true)
  })
  it.each([false, true])('uses negotiated native restoration (resume: %s), discarding replay', async resume => {
    const { turn, sent, update } = connection({ load: true, resume })
    await turn.prompt({ cwd: '/workspace', text: 'continue', nativeSessionId: 'native', mcpServers: [] })
    expect(sent.map(message => message.method)).toEqual(['initialize', resume ? 'session/resume' : 'session/load', 'session/prompt'])
    expect(update).not.toHaveBeenCalled()
  })
  it('never silently substitutes a new chat when restoration is unavailable or fails', async () => {
    const unavailable = connection()
    await expect(unavailable.turn.prompt({ cwd: '/workspace', text: 'go', nativeSessionId: 'native', mcpServers: [] })).rejects.toThrow('restoring')
    expect(unavailable.sent).toHaveLength(1)
    const missing = connection({ load: true, error: true })
    await expect(missing.turn.prompt({ cwd: '/workspace', text: 'go', nativeSessionId: 'native', mcpServers: [] })).rejects.toThrow('Session missing')
    expect(missing.sent.map(message => message.method)).not.toContain('session/new')
  })
  it.each([false, true])('handles fragmented UTF-8, session isolation, permissions and cancellation (%s)', async permissionRequired => {
    const { turn, child, sent, receive, update } = connection({ hold: true, permissionRequired })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: [] })
    const rejected = expect(pending).rejects.toThrow('test cancelled')
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    const bytes = Buffer.from(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } } })}\n`)
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]))
    receive({ method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk' } } })
    expect(update).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
    receive({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } })
    expect(sent.at(-1).result.outcome.optionId).toBe(permissionRequired ? 'no' : 'yes')
    turn.cancel()
    expect(sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'native' } })
    turn.dispose(new Error('test cancelled'))
    await rejected
  })
  it('fails pending work on a corrupt frame or early exit', async () => {
    for (const kind of ['corrupt-frame', 'early-exit'] as const) {
      const { turn, child } = connection({ hold: true })
      const pending = turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: [] })
      const rejected = expect(pending).rejects.toThrow()
      if (kind === 'corrupt-frame') child.stdout.write('{"jsonrpc":"2.0",\n')
      else child.emit('close', 1)
      await rejected
      turn.dispose()
    }
  })
  it('skips a dependency log line on stdout without disposing the turn', async () => {
    const { turn, sent, child, receive, update } = connection({ hold: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', mcpServers: [] })
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    // A plain-text line (e.g. an SDK console.debug) is not an ACP frame; it must
    // not be mistaken for protocol corruption and kill the turn.
    child.stdout.write('Client.listResourceTemplates() called but server does not advertise resources capability\n')
    receive({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after noise' } } } })
    receive({ id: sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })
    await expect(pending).resolves.toBe('end_turn')
    expect(update).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after noise' } })
  })
})

describe('native CLI event translation', () => {
  it('keeps text, thinking and both successful and failed tools', () => {
    const host = { text: vi.fn(), reasoning: vi.fn(), toolStarted: vi.fn(), toolCompleted: vi.fn(), fail: vi.fn() }
    applyNativeAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }, host)
    applyNativeAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }, host)
    applyNativeAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read', rawInput: { path: 'a.ts' }, status: 'completed', rawOutput: 'file' }, host)
    applyNativeAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'failed', rawOutput: 'denied' }, host)
    expect(host.text).toHaveBeenCalledWith('answer', true)
    expect(host.reasoning).toHaveBeenCalledWith('thinking')
    expect(host.toolStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'read', arguments: { path: 'a.ts' } }))
    expect(host.toolCompleted.mock.calls.map(([item]) => [item.id, item.output, item.error?.message])).toEqual([['read', 'file', undefined], ['write', 'denied', 'denied']])
  })
  it('maps the official ZCode JSONL protocol without duplicating message snapshots', () => {
    const host = { text: vi.fn(), reasoning: vi.fn(), toolStarted: vi.fn(), toolCompleted: vi.fn(), fail: vi.fn() }
    applyZcodeEvent({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'answer' } }, host)
    applyZcodeEvent({ type: 'message.upserted', payload: { content: 'answer' } }, host)
    applyZcodeEvent({ type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'tool', toolName: 'Bash', input: { command: 'pwd' } } }, host)
    applyZcodeEvent({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tool', result: { content: '/workspace' } } }, host)
    applyZcodeEvent({ type: 'turn.failed', payload: { error: { message: 'failed' } } }, host)
    expect(host.text).toHaveBeenCalledExactlyOnceWith('answer', true)
    expect(host.toolCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool', output: '/workspace' }))
    expect(host.fail).toHaveBeenCalledWith('failed')
  })
})
