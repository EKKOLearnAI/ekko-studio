import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool, ModelClient, ModelRequest } from '../../packages/ekko-agent/src'
import { EkkoAgent, EkkoProfileAgent } from '../../packages/ekko-agent/src'

let baseDirectory = ''

beforeEach(async () => {
  baseDirectory = await mkdtemp(join(tmpdir(), 'ekko-profile-agent-'))
})

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true })
})

describe('profile agent facade', () => {
  it('creates one independent agent facade per profile and exposes dynamic profile properties', () => {
    const ekko = new EkkoAgent({
      baseDirectory,
      profiles: ['work', 'personal'],
      env: { NODE_ENV: 'test' },
    })
    try {
      const work = Reflect.get(ekko, 'work') as EkkoProfileAgent
      const personal = ekko.agent.get('personal')

      expect(ekko.agent.names()).toEqual(['default', 'work', 'personal'])
      expect(ekko.default).toBe(ekko.agent.get('default'))
      expect(work).toBe(ekko.getAgent('work'))
      expect(work).not.toBe(personal)
      expect(work.skill).not.toBe(personal.skill)
      expect(work.memory).not.toBe(personal.memory)
      expect(work.validation).toMatchObject({
        profile: 'work',
        configSchemaVersion: 14,
        directories: {
          skill: join(baseDirectory, '.ekko', 'skills', 'work'),
          log: join(baseDirectory, '.ekko', 'logs', 'work'),
          workspace: join(baseDirectory, '.ekko', 'workspace', 'work'),
        },
      })
    } finally {
      ekko.close()
    }
  })

  it('binds tool, runtime, conversation, log, and memory operations to the profile', async () => {
    const ekko = new EkkoAgent({
      baseDirectory,
      profiles: ['work'],
      env: { NODE_ENV: 'test' },
    })
    const work = ekko.agent.get('work')
    const runtimeToolProfiles: Array<string | undefined> = []
    const tool: AgentTool = {
      definition: { name: 'work_only', description: 'Profile scoped tool' },
      async execute(_input, context) {
        runtimeToolProfiles.push(context?.profileId)
        return { ok: true, content: context?.profileId || '' }
      },
    }
    work.tool.register(tool)

    const requests: ModelRequest[] = []
    let requestCount = 0
    const modelClient: ModelClient = {
      provider: 'test',
      requestStyle: 'openai-chat',
      capabilities: {
        streaming: false,
        tools: true,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      async create(request) {
        requests.push(request)
        requestCount += 1
        if (requestCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'work-call', name: 'work_only', arguments: {} }],
          }
        }
        return { content: 'done' }
      },
      async *stream() {},
    }

    try {
      await expect(work.tool.execute('work_only', {})).resolves.toMatchObject({
        ok: true,
        content: 'work',
      })
      expect(ekko.default.tool.get('work_only')).toBeUndefined()

      await work.runtime.create({ modelClient }).run({
        messages: ['hello'],
        toolContext: { profileId: 'attempted-override' },
      })
      expect(requests[0].tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'work_only' }),
      ]))
      expect(requests[0].messages[0].content).toContain('profile: work')
      expect(runtimeToolProfiles).toContain('work')

      const session = work.conversation.createSession({ title: 'Work session' })
      expect(session.profile).toBe('work')
      expect(ekko.default.conversation.getSession(session.id)).toBeNull()
      expect(work.conversation.getSession(session.id)).toMatchObject({ profile: 'work' })

      expect(work.log.write({ category: 'system', event: 'profile.bound' })).toBe(true)
      expect(work.log.query({ event: 'profile.bound' })).toEqual([
        expect.objectContaining({ profile: 'work', event: 'profile.bound' }),
      ])

      await work.memory.create({
        kind: 'profile_name',
        node: { content: 'Work profile', title: 'Profile' },
        reason: 'profile facade test',
        explicitUserIntent: true,
        identity: { sessionId: session.id },
      })
      expect(await work.memory.list()).toEqual([
        expect.objectContaining({ profileId: 'work' }),
      ])
      expect(await ekko.default.memory.list()).toEqual([])
    } finally {
      ekko.close()
    }
  })

  it('lets a host create a profile runtime before selecting a provider', async () => {
    const ekko = new EkkoAgent({ baseDirectory, profiles: ['work'], env: { NODE_ENV: 'test' } })
    const client: ModelClient = {
      provider: 'host-owned',
      requestStyle: 'custom-runtime',
      capabilities: {
        streaming: false,
        tools: false,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      async create() {
        return { content: 'host client' }
      },
      async *stream() {},
    }

    try {
      const runtime = ekko.agent.get('work').runtime.create({ memory: false })
      await expect(runtime.run({ messages: ['hello'], modelClient: client })).resolves.toMatchObject({
        output: { content: 'host client' },
      })
    } finally {
      ekko.close()
    }
  })

  it('supports process-level profile creation/removal and validates config before construction', async () => {
    const ekko = new EkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      const created = ekko.agent.create('review')
      expect(created.profile).toBe('review')
      expect(Reflect.get(ekko, 'review')).toBe(created)
      expect(ekko.agent.remove('review')).toBe(true)
      expect(Reflect.has(ekko, 'review')).toBe(false)
      expect(() => ekko.agent.remove('default')).toThrow(/cannot be removed/)

      const configStore = ekko.config
      expect(ekko.agent.create('config').profile).toBe('config')
      expect(ekko.config).toBe(configStore)
      expect(ekko.agent.remove('config')).toBe(true)
      expect(ekko.config).toBe(configStore)

      await writeFile(ekko.layout.configPath, '{ invalid json\n')
      expect(() => ekko.agent.create('broken')).toThrow()
      expect(ekko.agent.has('broken')).toBe(false)
    } finally {
      ekko.close()
    }
  })

  it('discovers existing profile directories when profiles is omitted', () => {
    const first = new EkkoAgent({
      baseDirectory,
      profiles: ['work', 'personal'],
      env: { NODE_ENV: 'test' },
    })
    first.close()

    const discovered = new EkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(discovered.agent.names()).toEqual(['default', 'personal', 'work'])
      expect(discovered.agent.get('work').profile).toBe('work')
      expect(Reflect.get(discovered, 'personal')).toBe(discovered.agent.get('personal'))
    } finally {
      discovered.close()
    }
  })

  it('rejects unsafe profile directory names before an agent is constructed', () => {
    const ekko = new EkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(() => ekko.agent.create('../outside')).toThrow(/Invalid Ekko profile/)
      expect(ekko.agent.has('../outside')).toBe(false)
    } finally {
      ekko.close()
    }
  })
})
