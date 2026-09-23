import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  profileDir: '',
  config: {} as Record<string, any>,
  runtime: { running: true, unified: false, targetProfile: 'default' },
  restartGateway: vi.fn().mockResolvedValue({ running: true }),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getProfileDir: vi.fn(() => mocks.profileDir),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', () => ({
  readConfigYamlForProfile: vi.fn(async () => structuredClone(mocks.config)),
  updateConfigYamlForProfile: vi.fn(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
    mocks.config = updater(structuredClone(mocks.config))
  }),
}))

vi.mock('../../packages/server/src/modules/hermes/services/gateway/autostart', () => ({
  getGatewayRuntimeStatusForProfile: vi.fn(async () => mocks.runtime),
  restartGatewayForProfile: mocks.restartGateway,
}))

import {
  createIncomingWebhook,
  enableIncomingWebhooks,
  listIncomingWebhooks,
  removeIncomingWebhook,
  setIncomingWebhookEnabled,
} from '../../packages/server/src/modules/hermes/services/incoming-webhooks'

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hermes-incoming-webhooks-'))
  mocks.profileDir = tempDir
  mocks.config = {
    platforms: {
      webhook: { enabled: true, extra: { host: '0.0.0.0', port: 9000 } },
      telegram: { enabled: true, home_channel: { chat_id: '123' } },
      discord: { enabled: false },
    },
  }
  mocks.runtime = { running: true, unified: false, targetProfile: 'default' }
  mocks.restartGateway.mockClear()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('incoming webhook subscriptions', () => {
  it('creates a signed subscription without exposing its secret in later lists', async () => {
    const created = await createIncomingWebhook('default', {
      name: 'Build Finished',
      events: ['build.completed'],
      prompt: 'Review {{ payload }}',
      deliver: 'telegram',
      skills: ['review'],
    })

    expect(created.name).toBe('build-finished')
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(created.url).toBe('http://localhost:9000/webhooks/build-finished')

    const stored = JSON.parse(await readFile(join(tempDir, 'webhook_subscriptions.json'), 'utf-8'))
    expect(stored['build-finished']).toMatchObject({
      events: ['build.completed'],
      deliver: 'telegram',
      skills: ['review'],
      secret: created.secret,
    })

    const listed = await listIncomingWebhooks('default')
    expect(listed.subscriptions).toEqual([
      expect.objectContaining({ name: 'build-finished', secret_set: true }),
    ])
    expect(listed.subscriptions[0]).not.toHaveProperty('secret')
  })

  it('rejects disabled destinations and channels without a home destination', async () => {
    await expect(createIncomingWebhook('default', { name: 'disabled', deliver: 'discord' }))
      .rejects.toThrow('is not enabled')

    mocks.config.platforms.matrix = { enabled: true }
    await expect(createIncomingWebhook('default', { name: 'no-home', deliver: 'matrix' }))
      .rejects.toThrow('has no home destination')

    await expect(createIncomingWebhook('default', {
      name: 'explicit-chat', deliver: 'matrix', deliver_chat_id: '!room:example.org',
    })).resolves.toMatchObject({ name: 'explicit-chat', deliver: 'matrix' })
  })

  it('keeps unified subscriptions scoped to their profile', async () => {
    mocks.runtime = { running: true, unified: true, targetProfile: 'default' }
    await createIncomingWebhook('work', { name: 'work-route', deliver: 'log' })
    await createIncomingWebhook('personal', { name: 'personal-route', deliver: 'log' })

    expect((await listIncomingWebhooks('work')).subscriptions.map(item => item.name)).toEqual(['work-route'])
    expect((await listIncomingWebhooks('personal')).subscriptions.map(item => item.name)).toEqual(['personal-route'])

    await setIncomingWebhookEnabled('work', 'work-route', false)
    expect((await listIncomingWebhooks('work')).subscriptions[0].enabled).toBe(false)
    await expect(removeIncomingWebhook('personal', 'work-route')).rejects.toThrow('not found')
  })

  it('enables the existing Hermes webhook platform and restarts the selected gateway', async () => {
    mocks.config.platforms.webhook.enabled = false

    await enableIncomingWebhooks('default')

    expect(mocks.config.platforms.webhook.enabled).toBe(true)
    expect(mocks.restartGateway).toHaveBeenCalledWith('default')
  })
})
