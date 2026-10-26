import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadSdk = vi.hoisted(() => vi.fn())
vi.mock('../../packages/ekko-agent/src/tools/computer-use/sdk', () => ({ loadComputerUseSdk: loadSdk }))
import { ComputerUseTool } from '../../packages/ekko-agent/src/tools/computer-use'
import { assessComputerUse } from '../../packages/ekko-agent/src/tools/computer-use/jev'
import { EkkoJevClient, type EkkoJevOverrides } from '../../packages/ekko-agent/src/jev'
import { AgentRuntime, AgentToolRegistry, type ModelClient } from '../../packages/ekko-agent/src'
import { FakeCuaSdkDriver } from '../fixtures/fake-cua-sdk'

const config = { enabled: true, apiKey: 'private-key', computerUseMatchEnabled: true, computerUseVerifyEnabled: true }
const upstream = vi.fn<typeof fetch>()
const args = { pid: 123, window_id: 456 }
const evidence = { ...args, snapshot_id: 's1', elements: [
  { role: 'AXStaticText', label: 'Saved', value: 'private-value' },
  { role: 'AXButton', label: 'Save', element_token: 's1:1', enabled: true, selected: false },
] }
let directory: string
let driver: FakeCuaSdkDriver
let tool: ComputerUseTool
let scope: AbortController

function answer(choice = 'candidate_0', confidence = .95) {
  return Response.json({ model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 },
    answers: { decision: { type: 'choice', choice, confidence } } })
}
function run<T>(operation: () => T, overrides: EkkoJevOverrides = {}, signal?: AbortSignal): T {
  return new EkkoJevClient({ ...config, ...overrides as object }).runScoped(signal, operation)
}
const context = () => ({ computerUseSessionSignal: scope.signal, workspaceRoot: directory })
const observe = (extra: Record<string, unknown> = {}) => tool.execute({ action: 'call', tool: 'get_window_state', arguments: args, ...extra }, context())
const assess = (feature: 'match' | 'verify' = 'match', input: unknown = evidence) => assessComputerUse(feature, feature === 'match' ? 'Save' : 'Saved label is visible', input, args)

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ekko-computer-jev-'))
  driver = new FakeCuaSdkDriver(1)
  scope = new AbortController()
  tool = new ComputerUseTool()
  loadSdk.mockReset().mockResolvedValue({ CuaDriver: { createConfigured: () => driver }, SessionPermissionMode: { Standard: 0 } })
  upstream.mockReset().mockImplementation(async () => answer())
  vi.stubGlobal('fetch', upstream)
})
afterEach(async () => {
  await tool.execute({ action: 'close' }, context())
  scope.abort()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('Computer Use JEV', () => {
  it('keeps default-off and unconfigured observations unchanged with zero provider requests', async () => {
    await tool.execute({ action: 'describe', tool: 'get_window_state' }, context())
    for (const settings of [{ computerUseMatchEnabled: false, computerUseVerifyEnabled: false }, { apiKey: '' }, { enabled: false }]) {
      const result = await run(() => observe({ target: 'Save', expectation: 'Saved' }), settings)
      expect(result.ok).toBe(true)
      expect((result.data as any).jev.match.status).toBe('skipped')
      expect((result.data as any).result.args).not.toHaveProperty('tree_format')
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('selects only an existing token, includes verification, and retains native images and status', async () => {
    await tool.execute({ action: 'describe', tool: 'get_window_state' }, context())
    upstream.mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer('met'))
    const result = await run(() => observe({ target: 'Fixture', expectation: 'Fixture button is visible' }))
    expect(result.ok).toBe(true)
    expect((result.data as any).jev).toMatchObject({
      match: { status: 'matched', element_token: 's1:1', ...args, snapshot_id: 's1' }, verify: { status: 'met' },
    })
    expect(result.content).toContain('JEV assessment (advisory)')
    expect(result.contentParts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }), expect.objectContaining({ type: 'text', text: expect.stringContaining('"status":"matched"') }),
    ]))
    expect(driver.calls).toHaveLength(1)
    expect(driver.calls[0].args.tree_format).toBe('both')
    const serialized = JSON.stringify(upstream.mock.calls.map(call => JSON.parse(String(call[1]?.body))))
    expect(serialized).not.toContain('s1:1')
    expect(serialized).not.toContain('iVBOR')
  })

  it('sends only bounded labels and states; verification accepts static elements without tokens', async () => {
    upstream.mockResolvedValue(answer('met'))
    expect(await run(() => assess('verify'))).toMatchObject({ status: 'met' })
    const request = JSON.parse(String(upstream.mock.calls[0][1]?.body))
    expect(request.state.nodes).toEqual([{ role: 'AXStaticText', label: 'Saved' }, { role: 'AXButton', label: 'Save', enabled: true, selected: false }])
    expect(JSON.stringify(request)).not.toContain('private-value')
  })

  it('ranks the full snapshot before limiting candidates and excludes disabled controls', async () => {
    const elements = Array.from({ length: 30 }, (_, i) => ({ role: 'AXButton', label: `Other ${i}`, element_token: `s1:${i}` }))
    elements.push({ role: 'AXButton', label: 'Save', element_token: 's1:save' })
    const result = await run(() => assess('match', { ...evidence, elements: [{ role: 'AXButton', label: 'Save', enabled: false, element_token: 'disabled' }, ...elements] }), { computerUseMatchCandidateLimit: 1 })
    expect(result).toMatchObject({ status: 'matched', element_token: 's1:save', considered: 1 })
  })

  it.each(['AXTextArea', 'Edit', 'text_field'])('matches native editable role %s without mistaking a table for a tab', async role => {
    const result = await run(() => assess('match', { ...evidence, elements: [
      { role: 'AXTable', label: 'Save', element_token: 's1:table' },
      { role, label: 'Save', element_token: 's1:editor' },
    ] }))
    expect(result).toMatchObject({ status: 'matched', element_token: 's1:editor', considered: 1 })
  })

  it.each([['none', .9, 'no_match'], ['candidate_0', .6, 'unavailable'], ['invented_token', .99, 'unavailable'], ['candidate_0', 1.1, 'unavailable']])('handles choice %s with confidence %s', async (choice, confidence, status) => {
    upstream.mockResolvedValue(answer(choice as string, confidence as number))
    expect(await run(() => assess())).toMatchObject({ status })
  })

  it.each(['met', 'not_met', 'unknown'])('preserves verification judgment %s', async status => {
    upstream.mockResolvedValue(answer(status))
    expect(await run(() => assess('verify'))).toMatchObject({ status })
  })

  it('gates matching and verification independently', async () => {
    expect(await run(() => assess(), { computerUseMatchEnabled: false })).toMatchObject({ status: 'skipped', reason: 'disabled' })
    upstream.mockResolvedValue(answer('unknown'))
    expect(await run(() => assess('verify'), { computerUseMatchEnabled: false })).toMatchObject({ status: 'unknown' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it.each([{ ...evidence, pid: 999 }, { ...evidence, snapshot_id: undefined }, { ...evidence, elements: [...evidence.elements, evidence.elements[1]] }])('rejects invalid native identity/tokens before evaluation', async input => {
    expect(await run(() => assess('match', input))).toMatchObject({ status: 'unavailable', reason: 'invalid_snapshot' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('bounds payloads before evaluation', async () => {
    const elements = Array.from({ length: 100 }, () => ({ role: 'AXStaticText', label: 'x'.repeat(1000) }))
    expect(await run(() => assess('verify', { ...evidence, elements }))).toMatchObject({ reason: 'input_too_large' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('marks filtered and degraded observations as partial evidence', async () => {
    upstream.mockResolvedValue(answer('unknown'))
    await run(() => assessComputerUse('verify', 'No errors are present', { ...evidence, degraded: true }, args))
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).state.truncated).toBe(true)
    await run(() => assessComputerUse('verify', 'No errors are present', evidence, { ...args, query: 'Save' }))
    expect(JSON.parse(String(upstream.mock.calls[1][1]?.body)).state.truncated).toBe(true)
  })

  it('preserves native errors and does not evaluate failed observations', async () => {
    await tool.execute({ action: 'describe', tool: 'get_window_state' }, context())
    vi.spyOn(driver, 'callTool').mockResolvedValue({ rawJson: JSON.stringify({ isError: true,
      structuredContent: { ok: false }, content: [{ type: 'text', text: 'Capture failed' }] }) })
    const result = await run(() => observe({ target: 'Save' }))
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Capture failed') })
    expect((result.data as any).jev).toBeUndefined()
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([undefined, ['candidate_0']])('returns unavailable for malformed provider answers (%j)', async choice => {
    upstream.mockResolvedValue(Response.json({ model: 'jev-test', answers: { decision: { type: 'choice', choice, ...(choice === undefined ? {} : { confidence: .99 }) } } }))
    expect(await run(() => assess())).toMatchObject({ status: 'unavailable', reason: 'invalid_result' })
  })

  it('preserves native success and screenshots on provider failure without replaying the observation', async () => {
    await tool.execute({ action: 'describe', tool: 'get_window_state' }, context())
    upstream.mockResolvedValue(Response.json({ error: 'secret-body' }, { status: 503 }))
    const result = await run(() => observe({ target: 'Fixture' }))
    expect(result.ok).toBe(true)
    expect(result.contentParts?.some(part => part.type === 'image')).toBe(true)
    expect((result.data as any).jev.match.status).toBe('unavailable')
    expect(result.content).not.toContain('secret-body')
    expect(driver.calls).toHaveLength(1)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('bounds providers that ignore cancellation and propagates caller cancellation', async () => {
    upstream.mockImplementation(() => new Promise(() => {}))
    expect(await run(() => assess(), { computerUseMatchTimeoutMs: 100 })).toMatchObject({ reason: 'timeout' })
    const cancellation = new AbortController()
    const pending = run(() => assess(), {}, cancellation.signal)
    cancellation.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('snapshots settings at the run boundary and preserves explicit disabling on the next run', async () => {
    const client = new EkkoJevClient(config)
    await client.runScoped(undefined, async () => {
      client.configure({ ...config, computerUseMatchEnabled: false })
      expect(await assess()).toMatchObject({ status: 'matched' })
    })
    expect(await client.runScoped(undefined, () => assess())).toMatchObject({ reason: 'disabled' })
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('rejects assessment text on input operations before SDK dispatch', async () => {
    const result = await run(() => tool.execute({ action: 'call', tool: 'click', arguments: args, target: 'Save' }, context()))
    expect(result.ok).toBe(false)
    expect(driver.calls).toHaveLength(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('delivers the assessment to the next model request in AgentRuntime', async () => {
    const registry = new AgentToolRegistry()
    registry.register(tool)
    let step = 0
    const client: ModelClient = { provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { tools: true, vision: true, streaming: false, jsonMode: false, systemPrompt: true }, stream: vi.fn(),
      create: async request => {
        step++
        if (step <= 2) return { content: '', toolCalls: [{ id: `step-${step}`, name: 'computer_use', arguments: step === 1
          ? { action: 'describe', tool: 'get_window_state' }
          : { action: 'call', tool: 'get_window_state', arguments: args, target: 'Fixture' } }] }
        const message = request.messages.find(item => item.toolCallId === 'step-2')!
        expect(message.content).toContain('"status":"matched"')
        expect(message.contentParts?.some(part => part.type === 'image')).toBe(true)
        return { content: 'Found the fixture button.' }
      },
    }
    const result = await new AgentRuntime({ modelClient: client, tools: registry, jev: config }).run({ messages: ['Find the fixture button.'], skillReviewEnabled: false, toolContext: { workspaceRoot: directory } })
    expect(result.output.content).toBe('Found the fixture button.')
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})
