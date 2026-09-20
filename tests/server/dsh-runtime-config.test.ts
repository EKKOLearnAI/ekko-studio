import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { prepareDshRuntime } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'
import { readDshMcpServers } from '../../packages/server/src/modules/coding-agents/services/dsh/config'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

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
      model: 'custom/model', baseUrl: 'http://127.0.0.1:1234/proxy/v1', contextWindow: 90000, outputLimit: 9000,
      compression: { enabled: true, threshold: 0.5, targetRatio: 0.2 }, imageInput: true }
    const prepared = await prepareDshRuntime(input)
    expect(prepared.args).toEqual(['--profile', 'acp', '--patch', join(rootDir, 'studio.patch.yml')])
    const overlay = parse(await readFile(join(rootDir, 'studio.patch.yml'), 'utf8'))
    expect(overlay.find((row: any) => row.id === 'llm-pi-ai').config.providers['ekko-studio']).toMatchObject({
      apiKeyEnv: 'HERMES_DSH_API_KEY', api: 'openai-responses', baseURL: input.baseUrl,
      models: [{ id: input.model, contextWindow: 90000, maxTokens: 9000, input: ['text', 'image'] }],
    })
    expect(overlay.find((row: any) => row.id === 'skill-filesystem').config.customSkillDirs).toEqual([join(sourceHome, 'skills'), sharedSkills])
    expect(overlay.find((row: any) => row.id === 'compaction-basic').config).toEqual({
      auto: true, thresholdRatio: 0.5, retainRatio: 0.2,
    })
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
})
