import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupEkkoAgent, type EkkoAgentSetup } from '../../packages/ekko-agent/src'
import {
  deleteEkkoMemory,
  listEkkoMemory,
  updateEkkoMemory,
} from '../../packages/server/src/modules/ekko/services/memory'
import {
  createEkkoSkill,
  deleteEkkoSkill,
  getEkkoSkill,
  listEkkoSkills,
  listEkkoExternalSkillDirectories,
  setEkkoSkillEnabled,
  updateEkkoExternalSkillDirectories,
  updateEkkoSkill,
} from '../../packages/server/src/modules/ekko/services/skills'
import { importEkkoSkill } from '../../packages/server/src/modules/ekko/services/skill-import'
import {
  createEkkoMcpServer,
  deleteEkkoMcpServer,
  injectManagedEkkoMcpServers,
  listEkkoMcpServers,
  resolveEkkoMcpServers,
  setEkkoMcpServerEnabled,
  updateEkkoMcpServer,
} from '../../packages/server/src/modules/ekko/services/mcp'
import {
  getEkkoSettings,
  updateEkkoSettings,
} from '../../packages/server/src/modules/ekko/services/config'

let baseDirectory = ''
let setup: EkkoAgentSetup

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-configuration-'))
  setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setup.close()
  await rm(baseDirectory, { recursive: true, force: true })
})

describe('Ekko configuration services', () => {
  it('updates user-facing settings without exposing or overwriting internal config state', () => {
    setup.config.setModelProvider('acme', {
      type: 'openai-compatible',
      label: 'Acme',
      defaultModel: 'acme-fast',
      models: ['acme-fast', 'acme-deep'],
      apiKey: 'secret-key',
    })
    setup.config.update({
      mcp: {
        profiles: {
          work: { servers: { local: { command: 'node', enabled: true } } },
        },
      },
      skills: {
        profiles: {
          work: { disabled: ['weather'], externalDirectories: ['/shared/skills'] },
        },
      },
    })

    const initial = getEkkoSettings(setup)
    expect(initial.providers).toEqual([{
      id: 'acme',
      label: 'Acme',
      defaultModel: 'acme-fast',
      models: ['acme-fast', 'acme-deep'],
      authorizationConfigured: false,
    }])
    expect(JSON.stringify(initial)).not.toContain('secret-key')

    const updated = updateEkkoSettings({
      ...initial.config,
      runtime: { ...initial.config.runtime, maxSteps: 120 },
      model: {
        ...initial.config.model,
        defaultProvider: 'acme',
        defaultModel: 'acme-deep',
        temperature: 0.4,
      },
      mcp: { enabled: false, profiles: { work: { servers: {} } } },
      skills: { enabled: false, reviewEveryToolCalls: 4, profiles: {} },
      memory: { ...initial.config.memory, enabled: false, recentMessageLimit: 12 },
      compression: {
        ...initial.config.compression,
        threshold: 0.65,
        protectLastN: 14,
      },
    }, setup)

    expect(updated.config).toMatchObject({
      runtime: { maxSteps: 120 },
      model: { defaultProvider: 'acme', defaultModel: 'acme-deep', temperature: 0.4 },
      mcp: { enabled: false },
      skills: { enabled: false, reviewEveryToolCalls: 4 },
      memory: { enabled: false, recentMessageLimit: 12 },
      compression: { threshold: 0.65, protectLastN: 14 },
    })
    expect(setup.memory.isEnabled).toBe(false)
    const stored = setup.config.read()
    expect(stored.model.providers.acme.apiKey).toBe('secret-key')
    expect(stored.mcp.profiles.work.servers.local.command).toBe('node')
    expect(stored.skills.profiles.work).toEqual({
      disabled: ['weather'],
      externalDirectories: ['/shared/skills'],
    })
  })

  it('lists, revises, and soft-deletes profile memory', async () => {
    const created = await setup.memory.create({
      kind: 'general_preference',
      itemKey: 'editor_theme',
      reason: 'Explicit preference.',
      explicitUserIntent: true,
      identity: { sessionId: 'settings-test', profileId: 'work' },
      node: { title: 'Editor theme', content: 'Prefers a dark editor.', tags: ['editor'] },
    })
    expect(created.accepted).toBe(true)

    const listed = await listEkkoMemory({ profile: 'work', status: 'active' }, setup)
    expect(listed).toMatchObject([{ id: created.nodeId, title: 'Editor theme' }])
    const updated = await updateEkkoMemory('work', created.nodeId!, {
      expectedRevision: created.node!.revision,
      title: 'IDE theme',
      content: 'Prefers a light editor.',
      tags: ['ide'],
    }, setup)
    expect(updated).toMatchObject({ revision: 2, title: 'IDE theme', tags: ['ide'] })

    const deleted = await deleteEkkoMemory('work', updated.id, updated.revision, setup)
    expect(deleted).toMatchObject({ id: updated.id, revision: 3, status: 'deleted' })

    const allStatuses = await listEkkoMemory({ profile: 'work' }, setup)
    expect(allStatuses.map(memory => memory.status).sort()).toEqual(['deleted', 'superseded'])
  })

  it('creates, reads, edits, and archives profile skills', async () => {
    const first = `---\nname: release-notes\ndescription: Draft release notes.\nmetadata:\n  keywords:\n    - release notes\n---\n\n# Release notes\n\nDraft a concise summary.\n`
    await createEkkoSkill('work', { name: 'release-notes', content: first }, setup)
    expect(await listEkkoSkills('work', 'draft release', setup)).toMatchObject([
      { name: 'release-notes', managedByEkko: true },
    ])
    expect((await getEkkoSkill('work', 'release-notes', setup)).content).toBe(first)

    const next = first.replace('concise summary', 'user-facing summary')
    expect((await updateEkkoSkill('work', 'release-notes', next, setup)).content).toBe(next)
    await deleteEkkoSkill('work', 'release-notes', setup)
    expect(await listEkkoSkills('work', 'release-notes', setup)).toEqual([])
  })

  it('does not delete synchronized built-in skills', async () => {
    const weather = (await listEkkoSkills('work', 'weather', setup))
      .find(skill => skill.name === 'weather')
    expect(weather).toMatchObject({ builtIn: true })
    await expect(deleteEkkoSkill('work', 'weather', setup))
      .rejects.toThrow('Built-in skill cannot be deleted')
    expect(await getEkkoSkill('work', 'weather', setup)).toMatchObject({ builtIn: true })
  })

  it('references external Skill roots and imports local Skill folders per Profile', async () => {
    const externalRoot = join(baseDirectory, 'team-skills')
    await mkdir(join(externalRoot, 'research', 'team-search'), { recursive: true })
    await writeFile(
      join(externalRoot, 'research', 'team-search', 'SKILL.md'),
      '---\nname: team-search\ndescription: Search shared team sources.\nmetadata:\n  keywords:\n    - team search\n---\n\n# Team search\nSearch team sources.\n',
    )
    updateEkkoExternalSkillDirectories('work', [externalRoot], setup)

    expect(await listEkkoExternalSkillDirectories('work', setup)).toEqual([
      { raw: externalRoot, expanded: externalRoot, exists: true, isDir: true },
    ])
    expect(await listEkkoSkills('work', 'team-search', setup)).toContainEqual(expect.objectContaining({
      name: 'team-search', category: 'research', source: 'external',
      sourcePath: externalRoot, enabled: true,
    }))
    await setEkkoSkillEnabled('work', 'team-search', false, setup)
    expect(await listEkkoSkills('work', 'team-search', setup)).toContainEqual(expect.objectContaining({
      name: 'team-search', enabled: false,
    }))
    const create = vi.fn(async () => ({ content: 'done' }))
    const modelClient = {
      provider: 'test',
      requestStyle: 'custom-runtime' as const,
      capabilities: {
        streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true,
      },
      create,
      stream: vi.fn(),
    }
    await setup.createRuntime({ profile: 'work', modelClient, memory: false })
      .run({ messages: ['use the shared search skill'] })
    expect(JSON.stringify(create.mock.calls.at(-1)?.[0]?.messages)).not.toContain('team-search')

    await setEkkoSkillEnabled('work', 'team-search', true, setup)
    await setup.createRuntime({ profile: 'work', modelClient, memory: false })
      .run({ messages: ['use the shared search skill'] })
    expect(JSON.stringify(create.mock.calls.at(-1)?.[0]?.messages)).toContain('team-search')

    const imported = await importEkkoSkill('work', [{
      filename: 'local-helper/SKILL.md',
      data: Buffer.from('# Local helper\nUse local helper instructions.\n'),
    }], 'utilities', setup)
    expect(imported).toMatchObject({
      name: 'local-helper', category: 'utilities', source: 'local', enabled: true,
    })
    await expect(readFile(
      join(setup.profile('work').skillDirectory, 'utilities', 'local-helper', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('Use local helper instructions.')
  })

  it('persists custom MCP servers and allows full profile-scoped managed CRUD', async () => {
    vi.stubEnv('HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT', '1')
    setup.ensureProfile('work')
    injectManagedEkkoMcpServers(setup)
    await createEkkoMcpServer('work', 'local-tools', {
      command: 'node', args: ['server.mjs'], env: { MODE: 'test' }, enabled: true,
    }, setup)
    expect(listEkkoMcpServers('work', setup)).toContainEqual({
      name: 'local-tools', managed: false,
      config: { command: 'node', args: ['server.mjs'], env: { MODE: 'test' }, enabled: true },
    })
    await createEkkoMcpServer('work', 'remote-tools', {
      type: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer test' },
    }, setup)
    expect(listEkkoMcpServers('work', setup)).toContainEqual({
      name: 'remote-tools', managed: false,
      config: {
        type: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer test' },
        enabled: true,
      },
    })
    for (const [index, alias] of ['http', 'streamable-http', 'streamableHttp', 'streamablehttp'].entries()) {
      const name = `http-alias-${index}`
      await createEkkoMcpServer('work', name, {
        type: alias as 'streamable_http',
        url: `https://example.com/http-mcp-${index}`,
      }, setup)
      expect(listEkkoMcpServers('work', setup)).toContainEqual({
        name,
        managed: false,
        config: {
          type: 'streamable_http',
          url: `https://example.com/http-mcp-${index}`,
          enabled: true,
        },
      })
    }
    await expect(createEkkoMcpServer('work', 'legacy-sse', {
      type: 'sse' as 'streamable_http',
      url: 'https://example.com/sse',
    }, setup)).rejects.toThrow('MCP server type must be stdio or streamable_http.')

    await updateEkkoMcpServer('work', 'local-tools', { command: 'node', enabled: false }, setup)
    expect(listEkkoMcpServers('work', setup).find(server => server.name === 'local-tools')?.config.enabled).toBe(false)

    const managedApi = listEkkoMcpServers('work', setup)
      .find(server => server.name === 'ekko-studio-api')!
    await updateEkkoMcpServer('work', 'ekko-studio-api', {
      ...managedApi.config,
      args: [...(managedApi.config.args ?? []), '--edited'],
    }, setup)
    expect(listEkkoMcpServers('work', setup)
      .find(server => server.name === 'ekko-studio-api')).toMatchObject({
        managed: true,
        config: { args: expect.arrayContaining(['--edited']) },
      })

    await setEkkoMcpServerEnabled('work', 'ekko-studio-api', false, setup)
    expect(listEkkoMcpServers('work', setup)
      .find(server => server.name === 'ekko-studio-api')).toMatchObject({
        managed: true,
        config: { enabled: false },
      })
    expect((resolveEkkoMcpServers('work', undefined, setup)?.['ekko-studio-api'] as { enabled?: boolean })?.enabled)
      .toBe(false)
    expect(listEkkoMcpServers('default', setup)
      .find(server => server.name === 'ekko-studio-api')?.config.enabled).toBe(true)

    const stored = JSON.parse(await readFile(setup.layout.configPath, 'utf8'))
    expect(stored.mcp.profiles.work.servers['local-tools']).toMatchObject({ command: 'node', enabled: false })
    expect(stored.mcp.profiles.work.servers['ekko-studio-api']).toMatchObject({ enabled: false })
    await deleteEkkoMcpServer('work', 'local-tools', setup)
    expect(listEkkoMcpServers('work', setup).some(server => server.name === 'local-tools')).toBe(false)
    await deleteEkkoMcpServer('work', 'ekko-studio-api', setup)
    expect(listEkkoMcpServers('work', setup).some(server => server.name === 'ekko-studio-api')).toBe(false)
    await createEkkoMcpServer('work', 'ekko-studio-api', { command: 'custom-api' }, setup)
    expect(listEkkoMcpServers('work', setup)
      .find(server => server.name === 'ekko-studio-api')).toMatchObject({
        managed: false,
        config: { command: 'custom-api' },
      })
  })
})
