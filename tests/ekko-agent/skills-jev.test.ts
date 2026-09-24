import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime, EkkoFileLogger, EkkoJevClient, type EkkoJevOverrides, type ModelClient, type ModelRequest } from '../../packages/ekko-agent/src'
import { resolveSkillRouting } from '../../packages/ekko-agent/src/tools/skills'
import { SkillReviewService } from '../../packages/ekko-agent/src/skills/review'
import { shouldReviewSkills } from '../../packages/ekko-agent/src/skills/jev'

const upstream = vi.fn<typeof fetch>()
let directory: string
const config = { enabled: true, apiKey: 'skill-key', skillsEnabled: true, skillsTimeoutMs: 1000 }
const evidence = [{ role: 'user' as const, content: 'A reusable technique worked.' }]

function answer(value: string, confidence = 0.95) {
  return { type: 'choice', choice: value, confidence, probabilities: { [value]: confidence } }
}
function response(answers: Record<string, unknown>) {
  return Response.json({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } })
}
function request(index = 0) { return JSON.parse(upstream.mock.calls[index][1]!.body as string) }
function key(index = 0) { return new Headers(upstream.mock.calls[index][1]?.headers).get('authorization') }
function client(overrides: EkkoJevOverrides = {}) { return new EkkoJevClient({ ...config, ...overrides }) }
function model(): ModelClient {
  return { provider: 'test', requestStyle: 'custom-runtime',
    capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true },
    create: vi.fn(async () => ({ content: 'Done.' })), stream: vi.fn() }
}
async function skill(name: string, description = 'Create sortable spreadsheets', valid = true) {
  await mkdir(join(directory, name), { recursive: true })
  await writeFile(join(directory, name, 'SKILL.md'), valid
    ? `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  keywords:\n    - ${name} keyword\n---\n# ${name}\nPrivate instructions for ${name}.\n`
    : `---\nname: different-name\n---\nInvalid skill`)
}
async function route(jev = client(), text = '把这些数字整理成可以筛选的表格', disabled: string[] = []) {
  return jev.runScoped(undefined, () => resolveSkillRouting(directory, text, [], disabled, true))
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ekko-skills-jev-'))
  upstream.mockReset().mockImplementation(async (_url, init) => {
    const body = JSON.parse(init!.body as string)
    return response(Object.fromEntries(Object.keys(body.questions).map(name => [name, answer(name === 'learning' ? 'skip' : 'applicable')])))
  })
  vi.stubGlobal('fetch', upstream)
})
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })

describe('JEV skill matching', () => {
  it('adds semantic matches after exact matches and sends only eligible metadata', async () => {
    await skill('exact-skill')
    await skill('spreadsheet')
    await skill('disabled')
    await skill('invalid', '', false)
    const result = await route(client(), 'exact-skill，另把数字整理成表格', ['disabled'])
    expect(result.matches.map(item => item.name)).toEqual(['exact-skill', 'spreadsheet'])
    expect(result.names).toEqual(['exact-skill', 'spreadsheet'])
    expect(request().state.skills.map((item: any) => item.name)).toEqual(['spreadsheet'])
    expect(JSON.stringify(request())).not.toContain('Private instructions')
    expect(JSON.stringify(request())).not.toContain(directory)
  })

  it('bounds evaluation candidates and loads at most three additions', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await skill(name)
    const result = await route(client({ skillsCandidateLimit: 4 }))
    expect(Object.keys(request().questions)).toHaveLength(4)
    expect(result.matches.map(item => item.name)).toEqual(['a', 'b', 'c'])
    expect(result.names).toHaveLength(5)
  })

  it.each([{ skillsEnabled: false }, { enabled: false }, { apiKey: '' }])('makes no requests when disabled/unconfigured: %j', async overrides => {
    await skill('spreadsheet')
    expect((await route(client(overrides))).matches).toEqual([])
    expect(await client(overrides).runScoped(undefined, () => shouldReviewSkills(evidence))).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([
    answer('applicable', 0.6), answer('unrelated'), answer('unexpected'),
    { type: 'score', score: 1, confidence: 0.99 }, answer('applicable', 2), null,
  ])('preserves exact matches for uncertain or invalid semantic decisions: %j', async decision => {
    await skill('exact-skill'); await skill('spreadsheet')
    upstream.mockResolvedValue(response({ skill_0: decision }))
    expect((await route(client(), 'exact-skill')).matches.map(item => item.name)).toEqual(['exact-skill'])
  })

  it('rejects a malformed batch without keeping partial additions', async () => {
    await skill('a'); await skill('b')
    upstream.mockResolvedValue(response({ skill_0: answer('applicable') }))
    expect((await route()).matches).toEqual([])
  })

  it('falls back on provider failure and on the per-decision deadline', async () => {
    await skill('spreadsheet')
    upstream.mockResolvedValue(response({}))
    expect((await route()).matches).toEqual([])
    upstream.mockResolvedValue(Response.json({ error: 'private content' }, { status: 503 }))
    expect((await route()).matches).toEqual([])
    upstream.mockImplementation(() => new Promise(() => {}))
    const diagnostics = vi.fn()
    await client({ skillsTimeoutMs: 100 }).runScoped(undefined,
      async () => expect((await resolveSkillRouting(directory, '制作表格', [], [], true)).matches).toEqual([]), diagnostics)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'skill_routing', status: 'fallback', reason: 'timeout' }))
    expect(upstream).toHaveBeenCalledTimes(3)
  })

  it('does not evaluate empty, exact-only, or oversized input', async () => {
    await skill('spreadsheet')
    await route(client(), '')
    await route(client(), 'spreadsheet')
    await route(client(), '私'.repeat(30_000))
    expect(upstream).not.toHaveBeenCalled()
  })

  it('keeps context estimation local and loads selected instructions during a real run', async () => {
    await skill('spreadsheet')
    const main = model()
    const logger = new EkkoFileLogger({ directory: join(directory, '.logs') })
    const runtime = new AgentRuntime({ modelClient: main, skillDirectory: directory, jev: config, logWriter: logger, logProfile: 'work' })
    await runtime.jev.runScoped(undefined, () => runtime.estimateContext({ messages: ['制作表格'] }))
    expect(upstream).not.toHaveBeenCalled()
    const result = await runtime.run({ messages: ['制作表格'], logContext: { sessionId: 'skills-session', turnId: 'skills-turn' } })
    expect(result.messages.some(message => message.role === 'tool' && message.content.includes('Private instructions for spreadsheet'))).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(logger.query().find(record => record.event === 'skill.jev')).toMatchObject({
      category: 'skill', profile: 'work', sessionId: 'skills-session', turnId: 'skills-turn',
      data: { stage: 'skill_routing', status: 'completed' },
    })
    expect(JSON.stringify(logger.query())).not.toMatch(/制作表格|Private instructions|skill-key/)
    runtime.jev.configure({ ...config, skillsEnabled: false })
    const disabled = await runtime.run({ messages: ['制作表格'] })
    expect(disabled.messages.some(message => message.role === 'tool')).toBe(false)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation and lets the runtime clean up its boundary state', async () => {
    await skill('spreadsheet')
    upstream.mockImplementation(() => new Promise(() => {}))
    const main = model()
    const runtime = new AgentRuntime({ modelClient: main, skillDirectory: directory, jev: config })
    const controller = new AbortController()
    const events: string[] = []
    const pending = runtime.run({ messages: ['制作表格'], signal: controller.signal, metadata: { session_id: 'cancel' }, onEvent: event => events.push(event.type) })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    expect(main.create).not.toHaveBeenCalled()
    expect(events).toContain('run.failed')
    runtime.jev.configure(false)
    await expect(runtime.run({ messages: ['继续'], metadata: { session_id: 'cancel' } })).resolves.toMatchObject({ output: { content: 'Done.' } })
  })

  it('honors a boundary interruption received while semantic matching is pending', async () => {
    await skill('spreadsheet')
    let release!: (value: Response) => void
    upstream.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const main = model()
    const runtime = new AgentRuntime({ modelClient: main, skillDirectory: directory, jev: config })
    const pending = runtime.run({ messages: ['制作表格'], metadata: { session_id: 'boundary' } })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1))
    expect(runtime.requestBoundaryInterrupt({ sessionId: 'boundary' }).status).toBe('accepted')
    release(response({ skill_0: answer('applicable') }))
    const result = await pending
    expect(result.output.finishReason).toBe('boundary_interrupt')
    expect(result.messages.some(message => message.role === 'tool')).toBe(false)
    expect(main.create).not.toHaveBeenCalled()
  })
})

describe('JEV learning preflight', () => {
  it.each([
    [answer('skip'), 0], [answer('skip', 0.6), 1], [answer('review'), 1], [null, 1], [answer('unknown'), 1],
  ])('only skips the full reviewer for a reliable negative decision: %j', async (decision, calls) => {
    upstream.mockResolvedValue(response({ learning: decision }))
    const reviewer = model()
    const service = new SkillReviewService({ skillDirectory: directory })
    const completed = vi.fn()
    const diagnostics = vi.fn()
    client().runScoped(undefined, () => service.schedule({ modelClient: reviewer, messages: evidence, onCompleted: completed }), diagnostics)
    await service.drain()
    expect(reviewer.create).toHaveBeenCalledTimes(calls as number)
    expect(completed).toHaveBeenCalledWith(expect.any(String), 0)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'skill_review' }))
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(evidence[0].content)
  })

  it('falls back to the full review on oversized evidence and provider failure', async () => {
    const reviewer = model()
    const service = new SkillReviewService({ skillDirectory: directory })
    const jev = client()
    jev.runScoped(undefined, () => service.schedule({ modelClient: reviewer, messages: [{ role: 'user', content: 'x'.repeat(65_000) }] }))
    await service.drain()
    expect(upstream).not.toHaveBeenCalled()
    upstream.mockResolvedValue(Response.json({}, { status: 429 }))
    jev.runScoped(undefined, () => service.schedule({ modelClient: reviewer, messages: evidence }))
    await service.drain()
    expect(reviewer.create).toHaveBeenCalledTimes(2)
  })

  it('snapshots each queued review configuration across profiles and subsequent edits', async () => {
    const service = new SkillReviewService({ skillDirectory: directory })
    let release!: () => void
    const first = model()
    vi.mocked(first.create).mockImplementation(() => new Promise(resolve => { release = () => resolve({ content: 'Done.' }) }))
    upstream.mockImplementation(async () => response({ learning: answer('review') }))
    const jev = client({ apiKey: 'first-profile' })
    jev.runScoped(undefined, () => service.schedule({ modelClient: first, messages: evidence }))
    await vi.waitFor(() => expect(first.create).toHaveBeenCalledTimes(1))
    const second = model()
    jev.configure({ ...config, apiKey: 'second-profile', skillsMinConfidence: 0.99 })
    jev.runScoped(undefined, () => service.schedule({ modelClient: second, messages: evidence }))
    jev.configure({ ...config, apiKey: 'later-key', skillsEnabled: false })
    upstream.mockImplementation(async () => response({ learning: answer('skip', 0.95) }))
    release()
    await service.drain()
    expect(key(0)).toBe('Bearer first-profile')
    expect(key(1)).toBe('Bearer second-profile')
    expect(second.create).toHaveBeenCalledTimes(1)
  })

  it('does not turn a cancelled queued preflight into a full review', async () => {
    const service = new SkillReviewService({ skillDirectory: directory })
    const reviewer = model()
    const failed = vi.fn()
    const controller = new AbortController()
    client().runScoped(controller.signal, () => service.schedule({ modelClient: reviewer, messages: evidence, onFailed: failed }))
    controller.abort()
    await service.drain()
    expect(upstream).not.toHaveBeenCalled()
    expect(reviewer.create).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledTimes(1)
  })

  it('uses the runtime learning threshold and shares the single switch with routing', async () => {
    let mainCalls = 0
    const main = model()
    const reviews: ModelRequest[] = []
    vi.mocked(main.create).mockImplementation(async request => {
      if (request.metadata?.purpose === 'ekko-skill-review') { reviews.push(request); return { content: 'Nothing to save.' } }
      return ++mainCalls % 2 === 1
        ? { content: '', toolCalls: [{ id: 'list', name: 'skill_list', arguments: {} }] }
        : { content: 'Done.' }
    })
    const runtime = new AgentRuntime({ modelClient: main, skillDirectory: directory, skillReviewEveryToolCalls: 1, jev: config })
    await runtime.run({ messages: ['完成任务'] })
    await runtime.drainSkillReviews()
    expect(request().questions).toHaveProperty('learning')
    expect(reviews).toHaveLength(0)
    runtime.jev.configure({ ...config, skillsEnabled: false })
    await runtime.run({ messages: ['完成任务'] })
    await runtime.drainSkillReviews()
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(reviews).toHaveLength(1)
  })
})
