import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { prepareDshRuntime, dshNeedsContinuationInstructions, dshIsNarrationOnlyStall, DSH_MAX_AUTO_CONTINUES, DSH_AUTO_CONTINUE_NUDGE } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'
import { readDshMcpServers } from '../../packages/server/src/modules/coding-agents/services/dsh/config'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('dshNeedsContinuationInstructions', () => {
  it.each([
    ['deepseek-v4-flash', false],
    ['deepseek-flash', false],
    ['DeepSeek-V4', false],
    ['deepseek-reasoner', false],
    ['Qwen3.8-27B', true],
    ['gpt-5', true],
    ['claude-opus-4-7', true],
    ['custom/model', true],
    ['test-model', true],
    [undefined, true],
    ['', true],
  ])('model %j -> %s', (model, expected) => {
    expect(dshNeedsContinuationInstructions(model)).toBe(expected)
  })
})

describe('dshIsNarrationOnlyStall', () => {
  it('treats the real incident narrations (end_turn, no tool call) as stalls', () => {
    // The four narration-only "Let me …:" steps from session muzqiqmjokjagr.
    const stalls = [
      'The table is filled correctly now. Let me fix a couple of units and verify the totals:',
      'The data is there but the font rendering looks broken (Chinese characters are missing in the PDF). Let me check the actual docx formatting:',
      'The docx XML is fine — the garbled PDF is a fontconfig/locale issue in the LibreOffice conversion. Let me fix the conversion environment:',
      'The PDF is missing Chinese fonts. Let me investigate the font setup:',
    ]
    for (const text of stalls) {
      expect(dshIsNarrationOnlyStall('end_turn', text, 0), text).toBe(true)
    }
  })

  it('treats a trailing colon as a stall regardless of intent phrase', () => {
    // Colon = "about to act" tell; the model stopped right before the tool call.
    expect(dshIsNarrationOnlyStall('end_turn', 'Checking the output:', 0)).toBe(true)
    expect(dshIsNarrationOnlyStall('end_turn', 'Now I’ll run the build:', 0)).toBe(true)
  })

  it('treats a period whose last sentence leads with an intent phrase as a stall', () => {
    expect(dshIsNarrationOnlyStall('end_turn', 'Let me fix the remaining totals.', 0)).toBe(true)
    expect(dshIsNarrationOnlyStall('end_turn', '接下来我来处理剩余的部分。', 0)).toBe(true)
    expect(dshIsNarrationOnlyStall('end_turn', 'I will re-run the conversion.', 0)).toBe(true)
    expect(dshIsNarrationOnlyStall('end_turn', '现在我需要核对一下金额。', 0)).toBe(true)
  })

  it('does NOT treat completed final answers as stalls', () => {
    const finals = [
      'All done. The contract is filled and the PDF is saved at /output/合同.pdf.',
      'Here is your total: 457,650.00 yuan. Let me know if you need anything else.',
      '任务已完成。',
      'The bid document shows 3 items. Next steps are up to you.',
      'Next: review the signed PDF before filing.',
      'I will send the final version tomorrow. The work is complete.',
      'Let me know if anything looks off, otherwise we are done.',
      'Great, the PDF renders fine now.',
    ]
    for (const text of finals) {
      expect(dshIsNarrationOnlyStall('end_turn', text, 0), text).toBe(false)
    }
  })

  it('ignores any turn where a real tool call ran', () => {
    expect(dshIsNarrationOnlyStall('end_turn', 'Let me fix the totals:', 1)).toBe(false)
    expect(dshIsNarrationOnlyStall('end_turn', 'Let me fix the totals:', 7)).toBe(false)
  })

  it('ignores reasons other than end_turn / max_tokens', () => {
    expect(dshIsNarrationOnlyStall('refusal', 'Let me fix the totals:', 0)).toBe(false)
    expect(dshIsNarrationOnlyStall('cancelled', 'Let me fix the totals:', 0)).toBe(false)
  })

  it('still treats max_tokens narration as a stall (truncated intent)', () => {
    expect(dshIsNarrationOnlyStall('max_tokens', 'Let me investigate the font setup:', 0)).toBe(true)
  })

  it('ignores empty / whitespace-only final text', () => {
    expect(dshIsNarrationOnlyStall('end_turn', '', 0)).toBe(false)
    expect(dshIsNarrationOnlyStall('end_turn', '   ', 0)).toBe(false)
  })

  it('exposes the auto-continue nudge and a sane cap', () => {
    expect(DSH_MAX_AUTO_CONTINUES).toBeGreaterThanOrEqual(1)
    expect(DSH_MAX_AUTO_CONTINUES).toBeLessThanOrEqual(3)
    expect(DSH_AUTO_CONTINUE_NUDGE.length).toBeGreaterThan(0)
  })
})

describe('DSH runtime home', () => {
  it.each([
    '{}\n',
    'theme: dark\n',
    'llm-pi-ai: {}\n',
    'llm-pi-ai:\n  providers: {}\n',
    'llm-pi-ai: null\n',
    'llm-pi-ai:\n  providers: null\n',
  ])('accepts settings without a Studio provider override: %s', async settings => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-empty-config-'))
    roots.push(root)
    const sourceHome = join(root, 'native'), rootDir = join(root, 'runtime')
    await mkdir(sourceHome)
    await writeFile(join(sourceHome, 'settings.yaml'), settings)
    await prepareDshRuntime({ sourceHome, rootDir, sharedSkills: join(root, 'shared'),
      systemPrompt: '', managedMcp: {}, model: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1' })
    expect(parse(await readFile(join(rootDir, 'settings.yaml'), 'utf8'))).toEqual(parse(settings))
    expect(await readFile(join(sourceHome, 'settings.yaml'), 'utf8')).toBe(settings)
  })

  it('keeps native settings intact while isolating models, prompts, persistence and managed MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-config-'))
    roots.push(root)
    const sourceHome = join(root, 'native'), rootDir = join(root, 'runtime'), sharedSkills = join(root, 'shared')
    await mkdir(join(sourceHome, 'profiles', 'acp'), { recursive: true })
    const settings = 'theme: dark\nllm-pi-ai:\n  providers:\n    ekko-studio:\n      baseURL: https://wrong.example/v1\n    custom:\n      apiKeyEnv: CUSTOM_KEY\n'
    const patch = '- id: unrelated\n  config:\n    value: !!js process.env.USER_VALUE\n'
    await writeFile(join(sourceHome, 'settings.yaml'), settings)
    await writeFile(join(sourceHome, 'cordis.patch.yml'), patch)
    await writeFile(join(sourceHome, 'AGENTS.md'), 'Native preferences\n')
    await writeFile(join(sourceHome, 'profiles/acp/custom.txt'), 'plugin asset')
    const input = { sourceHome, rootDir, sharedSkills, systemPrompt: 'Studio system prompt',
      managedMcp: { 'ekko-studio-api': { command: 'node', args: ['api.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } },
      model: 'custom/model', baseUrl: 'http://127.0.0.1:1234/proxy/v1', contextWindow: 90000, outputLimit: 9000, imageInput: true }
    const prepared = await prepareDshRuntime(input)
    expect(prepared.args).toEqual(['--profile', 'acp', '--patch', join(rootDir, 'studio.patch.yml')])
    const overlay = parse(await readFile(join(rootDir, 'studio.patch.yml'), 'utf8'))
    expect(overlay.find((row: any) => row.id === 'llm-pi-ai').config.providers['ekko-studio']).toMatchObject({
      apiKeyEnv: 'HERMES_DSH_API_KEY', api: 'openai-responses', baseURL: input.baseUrl,
      models: [{ id: input.model, contextWindow: 90000, maxTokens: 9000, input: ['text', 'image'] }],
    })
    expect(overlay.find((row: any) => row.id === 'skill-filesystem').config.customSkillDirs).toEqual([join(sourceHome, 'skills'), sharedSkills])
    expect(overlay.find((row: any) => row.id === 'session-persistence-jsonl').config.root).toBe(join(rootDir, 'sessions'))
    expect(await readFile(prepared.promptFile, 'utf8')).toContain('Native preferences')
    expect(await readFile(prepared.promptFile, 'utf8')).toContain('Studio system prompt')
    expect(await readFile(join(rootDir, 'profiles/acp/custom.txt'), 'utf8')).toBe('plugin asset')
    const runtimePatch = await readFile(join(rootDir, 'cordis.patch.yml'), 'utf8')
    expect(runtimePatch).toContain('!!js process.env.USER_VALUE')
    expect(readDshMcpServers(runtimePatch).get('ekko-studio-api')?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    const runtimeSettings = parse(await readFile(join(rootDir, 'settings.yaml'), 'utf8'))
    expect(runtimeSettings['llm-pi-ai'].providers['ekko-studio']).toBeUndefined()
    expect(runtimeSettings['llm-pi-ai'].providers.custom).toEqual({ apiKeyEnv: 'CUSTOM_KEY' })
    expect(await readFile(join(sourceHome, 'settings.yaml'), 'utf8')).toBe(settings)
    expect(await readFile(join(sourceHome, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    if (process.platform !== 'win32') expect((await stat(join(rootDir, 'settings.yaml'))).mode & 0o777).toBe(0o600)
    await mkdir(join(rootDir, 'sessions'))
    await writeFile(join(rootDir, 'sessions/native.jsonl'), 'persisted turn')
    await prepareDshRuntime({ ...input, systemPrompt: 'Next turn' })
    expect(await readFile(join(rootDir, 'sessions/native.jsonl'), 'utf8')).toBe('persisted turn')
    expect(await readFile(prepared.promptFile, 'utf8')).not.toContain('Studio system prompt')
  })

  it.each([
    ['Qwen3.8-27B', true],
    ['deepseek-v4-flash', false],
  ])('injects continuation rules for %s', async (model, shouldInject) => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-continuation-'))
    roots.push(root)
    const sourceHome = join(root, 'native'), rootDir = join(root, 'runtime')
    await mkdir(sourceHome)
    await prepareDshRuntime({ sourceHome, rootDir, sharedSkills: join(root, 'shared'),
      systemPrompt: '', managedMcp: {}, model, baseUrl: 'http://127.0.0.1:1234/v1' })
    const agents = await readFile(join(rootDir, 'AGENTS.md'), 'utf8')
    if (shouldInject) expect(agents).toContain('工具调用行为准则')
    else expect(agents).not.toContain('工具调用行为准则')
  })
})
