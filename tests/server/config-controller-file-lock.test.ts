import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

const { mockGatewayAutostartDisabledByEnv, mockRestartGateway, mockReconcileGatewayManagement, mockDestroyProfile } = vi.hoisted(() => ({
  mockGatewayAutostartDisabledByEnv: vi.fn(() => false),
  mockRestartGateway: vi.fn().mockResolvedValue({ running: true, profile: 'default' }),
  mockReconcileGatewayManagement: vi.fn().mockResolvedValue({
    changed: false,
    previousUnified: false,
    nextUnified: false,
    stoppedProfiles: [],
    startedProfiles: [],
  }),
  mockDestroyProfile: vi.fn().mockResolvedValue({ destroyed: true }),
}))

vi.mock('../../packages/server/src/modules/hermes/services/gateway/autostart', () => {
  return {
    gatewayAutostartDisabledByEnv: mockGatewayAutostartDisabledByEnv,
    reconcileGatewayManagementTransition: mockReconcileGatewayManagement,
    restartGatewayForProfile: mockRestartGateway,
  }
})

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: class {
    destroyProfile = mockDestroyProfile
  },
}))

const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const tempHomes: string[] = []
let hermesHome = ''
const invalidateProviderRuntime = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ invalidateProviderRuntime }))

async function loadController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = hermesHome
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/config')
}

function makeCtx(body: unknown, profile?: string): any {
  return {
    request: { body },
    query: {},
    state: profile ? { profile: { name: profile } } : {},
    get: vi.fn(() => ''),
    status: 200,
    body: undefined,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockGatewayAutostartDisabledByEnv.mockReturnValue(false)
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

it('invalidates scoped coding runtimes after a profile compression threshold change is saved', async () => {
  const { updateConfig } = await loadController()
  const ctx = makeCtx({ section: 'compression', values: { enabled: false, threshold: 0.65 } }, 'research')
  await updateConfig(ctx)
  expect(ctx.status).toBe(200)
  expect(invalidateProviderRuntime).toHaveBeenCalledWith('research')
})

it('does not restart coding runtimes when only ordinary chat compression is toggled', async () => {
  const { updateConfig } = await loadController()
  const ctx = makeCtx({ section: 'compression', values: { enabled: false } }, 'research')
  await updateConfig(ctx)
  expect(ctx.body.success).toBe(true)
  expect(invalidateProviderRuntime).not.toHaveBeenCalled()
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

describe('config controller locked file updates', () => {
  it('deep merges a config section and restarts the gateway through hermes-cli', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  enabled: false',
      '  extra:',
      '    mode: old',
      'model:',
      '  default: glm-5.1',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig } = await loadController()
    const ctx = makeCtx({ section: 'telegram', values: { enabled: true, extra: { token_mode: 'env' } } })

    await updateConfig(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).toHaveBeenCalledWith('default')
    expect(mockDestroyProfile).not.toHaveBeenCalled()
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.telegram.enabled).toBe(true)
    expect(config.telegram.extra).toEqual({ mode: 'old', token_mode: 'env' })
    expect(config.model.default).toBe('glm-5.1')
  })

  it('does not auto-restart gateway for channel config when gateway auto-start is disabled', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  enabled: false',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, 'config.json'), JSON.stringify({
      gatewayAutoStart: { enabled: false },
    }), 'utf-8')
    const { updateConfig } = await loadController()
    const ctx = makeCtx({ section: 'telegram', values: { enabled: true } })

    await updateConfig(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.telegram.enabled).toBe(true)
  })

  it('does not auto-restart gateway for channel config when gateway autostart is disabled by env', async () => {
    mockGatewayAutostartDisabledByEnv.mockReturnValue(true)
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  enabled: false',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig } = await loadController()
    const ctx = makeCtx({ section: 'telegram', values: { enabled: true } })

    await updateConfig(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).not.toHaveBeenCalled()
  })


  it('reads and writes gateway auto-start policy from Web UI app config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: keep-model',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig, getConfig } = await loadController()

    const writeCtx = makeCtx({
      section: 'gatewayAutoStart',
      values: {
        enabled: true,
        management: 'unified',
        include: ['default', ' reviewer ', '', 'default'],
        exclude: ['scratch', ' missing '],
      },
    })
    await updateConfig(writeCtx)

    expect(writeCtx.body).toEqual({
      success: true,
      gatewayAutoStart: {
        enabled: true,
        management: 'unified',
        include: ['default', 'reviewer'],
        exclude: ['scratch', 'missing'],
      },
    })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    expect(mockReconcileGatewayManagement).toHaveBeenCalledWith({
      management: 'per_profile',
    }, {
      enabled: true,
      management: 'unified',
      include: ['default', 'reviewer'],
      exclude: ['scratch', 'missing'],
    })

    const persisted = JSON.parse(await readFile(join(hermesHome, 'config.json'), 'utf-8'))
    expect(persisted.gatewayAutoStart).toEqual({
      enabled: true,
      include: ['default', 'reviewer'],
      exclude: ['scratch', 'missing'],
    })
    const yamlConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(yamlConfig.gatewayAutoStart).toBeUndefined()
    expect(yamlConfig.multiplex_profiles).toBe(true)
    expect(yamlConfig.gateway).toBeUndefined()
    expect(yamlConfig.model.default).toBe('keep-model')

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.gatewayAutoStart).toEqual({
      enabled: true,
      management: 'unified',
      include: ['default', 'reviewer'],
      exclude: ['scratch', 'missing'],
    })
  })

  it('does not reconcile gateway management when Web UI gateway auto-start is disabled', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: keep-model\n', 'utf-8')
    const { updateConfig } = await loadController()

    const ctx = makeCtx({
      section: 'gatewayAutoStart',
      values: {
        enabled: false,
        management: 'unified',
      },
    })
    await updateConfig(ctx)

    expect(ctx.body).toEqual({
      success: true,
      gatewayAutoStart: {
        enabled: false,
        management: 'unified',
      },
    })
    expect(mockReconcileGatewayManagement).not.toHaveBeenCalled()
  })

  it('does not reconcile gateway management when gateway autostart is disabled by env', async () => {
    mockGatewayAutostartDisabledByEnv.mockReturnValue(true)
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: keep-model\n', 'utf-8')
    const { updateConfig } = await loadController()

    const ctx = makeCtx({
      section: 'gatewayAutoStart',
      values: {
        enabled: true,
        management: 'unified',
      },
    })
    await updateConfig(ctx)

    expect(ctx.body).toEqual({
      success: true,
      gatewayAutoStart: {
        enabled: true,
        management: 'unified',
      },
    })
    expect(mockReconcileGatewayManagement).not.toHaveBeenCalled()
  })

  it('removes Hermes multiplex gateway config when unified gateway is disabled', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'gateway:',
      '  multiplex_profiles: true',
      'model:',
      '  default: keep-model',
      '',
    ].join('\n'), 'utf-8')
    const { updateConfig } = await loadController()

    const ctx = makeCtx({
      section: 'gatewayAutoStart',
      values: {
        management: 'per_profile',
      },
    })
    await updateConfig(ctx)

    expect(ctx.body.gatewayAutoStart.management).toBe('per_profile')
    const yamlConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(yamlConfig.gateway).toBeUndefined()
    expect(yamlConfig.multiplex_profiles).toBeUndefined()
    expect(yamlConfig.model.default).toBe('keep-model')
  })

  it('clears credential env values and removes matching config fields without losing unrelated env keys', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  weixin:',
      '    token: old-token',
      '    extra:',
      '      account_id: old-account',
      '      base_url: https://old.example',
      'model:',
      '  default: glm-5.1',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'OPENROUTER_API_KEY=keep',
      'WEIXIN_TOKEN=old-token',
      'WEIXIN_ACCOUNT_ID=old-account',
      '',
    ].join('\n'), 'utf-8')
    const { updateCredentials } = await loadController()
    const ctx = makeCtx({ platform: 'weixin', values: { token: '', extra: { account_id: '', base_url: 'https://new.example' } } })

    await updateCredentials(ctx)

    expect(ctx.body).toEqual({ success: true })
    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).not.toContain('WEIXIN_TOKEN=')
    expect(env).not.toContain('WEIXIN_ACCOUNT_ID=')
    expect(env).toContain('WEIXIN_BASE_URL=https://new.example')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.weixin.token).toBeUndefined()
    expect(config.platforms.weixin.extra.account_id).toBeUndefined()
    expect(config.platforms.weixin.extra.base_url).toBe('https://old.example')
    expect(config.model.default).toBe('glm-5.1')
  })

  it('does not auto-restart gateway after credential updates when gateway auto-start is disabled', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  weixin:',
      '    token: old-token',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, 'config.json'), JSON.stringify({
      gatewayAutoStart: { enabled: false },
    }), 'utf-8')
    const { updateCredentials } = await loadController()
    const ctx = makeCtx({ platform: 'weixin', values: { token: 'new-token' } })

    await updateCredentials(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('WEIXIN_TOKEN=new-token')
  })

  it('does not auto-restart gateway after credential updates when gateway autostart is disabled by env', async () => {
    mockGatewayAutostartDisabledByEnv.mockReturnValue(true)
    await writeFile(join(hermesHome, 'config.yaml'), 'platforms: {}\n', 'utf-8')
    const { updateCredentials } = await loadController()
    const ctx = makeCtx({ platform: 'weixin', values: { token: 'new-token' } })

    await updateCredentials(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mockRestartGateway).not.toHaveBeenCalled()
  })

  it('writes QQBot credentials to env and overlays them into platform config reads', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  qqbot:',
      '    extra:',
      '      markdown_support: true',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'qqbot',
      values: {
        extra: { app_id: 'qq-app', client_secret: 'qq-secret' },
        allowed_users: 'user-1,user-2',
        allow_all_users: false,
      },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('QQ_APP_ID=qq-app')
    expect(env).toContain('QQ_CLIENT_SECRET=qq-secret')
    expect(env).toContain('QQ_ALLOWED_USERS=user-1,user-2')
    expect(env).toContain('QQ_ALLOW_ALL_USERS=false')

    const ctx = makeCtx({})
    await getConfig(ctx)
    expect(ctx.body.platforms.qqbot.extra.app_id).toBe('qq-app')
    expect(ctx.body.platforms.qqbot.extra.client_secret).toBe('qq-secret')
    expect(ctx.body.platforms.qqbot.extra.markdown_support).toBe(true)
    expect(ctx.body.platforms.qqbot.allowed_users).toBe('user-1,user-2')
    expect(ctx.body.platforms.qqbot.allow_all_users).toBe(false)
  })

  it('round-trips Feishu webhook credentials through env-backed platform settings', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  feishu:',
      '    extra:',
      '      mode: webhook',
      '      app_id: old-config-app',
      '      encrypt_key: old-config-encrypt',
      '      verification_token: old-config-verify',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'feishu',
      values: {
        extra: {
          app_id: 'cli_test_app',
          app_secret: 'feishu-secret',
          encrypt_key: 'feishu-encrypt',
          verification_token: 'feishu-verify',
        },
      },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('FEISHU_APP_ID=cli_test_app')
    expect(env).toContain('FEISHU_APP_SECRET=feishu-secret')
    expect(env).toContain('FEISHU_ENCRYPT_KEY=feishu-encrypt')
    expect(env).toContain('FEISHU_VERIFICATION_TOKEN=feishu-verify')

    const migratedConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(migratedConfig.platforms.feishu.extra.mode).toBe('webhook')
    expect(migratedConfig.platforms.feishu.extra.app_id).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.app_secret).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.encrypt_key).toBeUndefined()
    expect(migratedConfig.platforms.feishu.extra.verification_token).toBeUndefined()

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.platforms.feishu.extra.mode).toBe('webhook')
    expect(readCtx.body.platforms.feishu.extra.app_id).toBe('cli_test_app')
    expect(readCtx.body.platforms.feishu.extra.app_secret).toBe('feishu-secret')
    expect(readCtx.body.platforms.feishu.extra.encrypt_key).toBe('feishu-encrypt')
    expect(readCtx.body.platforms.feishu.extra.verification_token).toBe('feishu-verify')

    await updateCredentials(makeCtx({
      platform: 'feishu',
      values: {
        extra: {
          app_id: '',
          app_secret: '',
          encrypt_key: '',
          verification_token: '',
        },
      },
    }))

    const clearedEnv = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(clearedEnv).toContain('OPENROUTER_API_KEY=keep')
    expect(clearedEnv).not.toContain('FEISHU_APP_ID=')
    expect(clearedEnv).not.toContain('FEISHU_APP_SECRET=')
    expect(clearedEnv).not.toContain('FEISHU_ENCRYPT_KEY=')
    expect(clearedEnv).not.toContain('FEISHU_VERIFICATION_TOKEN=')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.feishu.extra.mode).toBe('webhook')
    expect(config.platforms.feishu.extra.app_id).toBeUndefined()
    expect(config.platforms.feishu.extra.app_secret).toBeUndefined()
    expect(config.platforms.feishu.extra.encrypt_key).toBeUndefined()
    expect(config.platforms.feishu.extra.verification_token).toBeUndefined()
  })

  it('round-trips Matrix password credentials through env-backed platform settings', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  matrix:',
      '    extra:',
      '      homeserver: https://old.example.org',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'matrix',
      values: {
        extra: {
          homeserver: 'https://matrix.example.org',
          user_id: '@hermes:example.org',
          password: 'matrix-secret',
        },
      },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('MATRIX_HOMESERVER=https://matrix.example.org')
    expect(env).toContain('MATRIX_USER_ID=@hermes:example.org')
    expect(env).toContain('MATRIX_PASSWORD=matrix-secret')

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.platforms.matrix.extra.homeserver).toBe('https://matrix.example.org')
    expect(readCtx.body.platforms.matrix.extra.user_id).toBe('@hermes:example.org')
    expect(readCtx.body.platforms.matrix.extra.password).toBe('matrix-secret')
  })

  it('round-trips platform proxy URLs through env-backed channel settings', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'platforms: {}\n', 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { updateCredentials, getConfig } = await loadController()

    await updateCredentials(makeCtx({
      platform: 'telegram',
      values: { proxy: 'socks5://127.0.0.1:7890' },
    }))
    await updateCredentials(makeCtx({
      platform: 'discord',
      values: { proxy: 'http://127.0.0.1:8080' },
    }))
    await updateCredentials(makeCtx({
      platform: 'matrix',
      values: { proxy: 'https://proxy.example:8443' },
    }))

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('TELEGRAM_PROXY=socks5://127.0.0.1:7890')
    expect(env).toContain('DISCORD_PROXY=http://127.0.0.1:8080')
    expect(env).toContain('MATRIX_PROXY=https://proxy.example:8443')

    const readCtx = makeCtx({})
    await getConfig(readCtx)
    expect(readCtx.body.platforms.telegram.proxy).toBe('socks5://127.0.0.1:7890')
    expect(readCtx.body.platforms.discord.proxy).toBe('http://127.0.0.1:8080')
    expect(readCtx.body.platforms.matrix.proxy).toBe('https://proxy.example:8443')

    await updateCredentials(makeCtx({
      platform: 'discord',
      values: { proxy: '' },
    }))
    const clearedEnv = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(clearedEnv).not.toContain('DISCORD_PROXY=')
  })

  it('round-trips global proxy env settings and restarts the gateway', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: glm-5.1\n', 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\nHTTP_PROXY=http://old.example:8080\n', 'utf-8')
    const { updateConfig, getConfig } = await loadController()

    await updateConfig(makeCtx({
      section: 'proxy',
      values: {
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        HTTP_PROXY: '',
        ALL_PROXY: 'socks5://127.0.0.1:7891',
        NO_PROXY: 'localhost,127.0.0.1,.local',
      },
    }))

    expect(mockRestartGateway).toHaveBeenCalledWith('default')
    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('HTTPS_PROXY=http://127.0.0.1:7890')
    expect(env).not.toContain('HTTP_PROXY=')
    expect(env).toContain('ALL_PROXY=socks5://127.0.0.1:7891')
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1,.local')

    const ctx = makeCtx({})
    await getConfig(ctx)
    expect(ctx.body.proxy).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7891',
      NO_PROXY: 'localhost,127.0.0.1,.local',
    })
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.proxy).toBeUndefined()
    expect(config.model.default).toBe('glm-5.1')
  })

  it('reads and writes channel settings in the request-scoped profile only', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), [
      'telegram:',
      '  require_mention: false',
      'model:',
      '  default: keep-default-model',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'TELEGRAM_BOT_TOKEN=keep-default-token',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'telegram:',
      '  require_mention: false',
      'model:',
      '  default: research-model',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, '.env'), [
      'TELEGRAM_BOT_TOKEN=old-research-token',
      '',
    ].join('\n'), 'utf-8')

    const { updateConfig, updateCredentials, getConfig } = await loadController()

    await updateConfig(makeCtx({
      section: 'telegram',
      values: { require_mention: true, free_response_chats: 'chat-1' },
    }, 'research'))
    await updateCredentials(makeCtx({
      platform: 'telegram',
      values: { token: 'new-research-token' },
    }, 'research'))

    expect(mockRestartGateway).toHaveBeenCalledWith('research')
    expect(mockDestroyProfile).not.toHaveBeenCalled()
    const defaultConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(defaultConfig.telegram.require_mention).toBe(false)
    expect(researchConfig.telegram.require_mention).toBe(true)
    expect(researchConfig.telegram.free_response_chats).toBe('chat-1')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=keep-default-token')
    expect(await readFile(join(researchDir, '.env'), 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=new-research-token')

    const ctx = makeCtx({}, 'research')
    await getConfig(ctx)
    expect(ctx.body.platforms.telegram.token).toBe('new-research-token')
    expect(ctx.body.telegram.require_mention).toBe(true)
  })

  it('reads and replaces auxiliary model settings in the requested profile', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: root-model',
      'auxiliary:',
      '  compression:',
      '    provider: openrouter',
      '    model: root-compressor',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'model:',
      '  default: research-model',
      'auxiliary:',
      '  vision:',
      '    provider: main',
      '  web_extract:',
      '    provider: auto',
      '    base_url: keep-visible-base-url',
      '    api_key: keep-visible-api-key',
      '',
    ].join('\n'), 'utf-8')

    const { getAuxiliaryModels, updateAuxiliaryModels } = await loadController()
    const readCtx = makeCtx({})
    readCtx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await getAuxiliaryModels(readCtx)

    expect(readCtx.body.auxiliary).toEqual({
      vision: { provider: 'main' },
      web_extract: {
        provider: 'auto',
        base_url: 'keep-visible-base-url',
        api_key: 'keep-visible-api-key',
      },
    })
    expect(readCtx.body.tasks.some((task: any) => task.key === 'compression' && task.default_timeout === 120)).toBe(true)
    expect(readCtx.body.tasks.some((task: any) => task.key === 'vision' && task.default_download_timeout === 30)).toBe(true)

    const writeCtx = makeCtx({
      auxiliary: {
        compression: {
          provider: ' openrouter ',
          model: ' google/gemini-3-flash-preview ',
          timeout: 120.7,
          download_timeout: 30,
          extra_body: { temperature: 0 },
          ignored: 'drop',
        },
        empty_task: {
          provider: 'auto',
          model: 'drop-model',
          base_url: 'drop-base-url',
          api_key: 'drop-api-key',
          extra_body: { should: 'drop' },
          timeout: 30,
        },
        blank_task: {
          provider: '',
          model: '',
        },
      },
    })
    writeCtx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await updateAuxiliaryModels(writeCtx)

    expect(writeCtx.body).toEqual({
      success: true,
      auxiliary: {
        compression: {
          provider: 'openrouter',
          model: 'google/gemini-3-flash-preview',
          timeout: 120,
          extra_body: { temperature: 0 },
        },
        empty_task: {
          provider: 'auto',
          timeout: 30,
        },
      },
    })
    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.auxiliary.compression.model).toBe('root-compressor')
    expect(researchConfig.model.default).toBe('research-model')
    expect(researchConfig.auxiliary).toEqual({
      compression: {
        provider: 'openrouter',
        model: 'google/gemini-3-flash-preview',
        timeout: 120,
        extra_body: { temperature: 0 },
      },
      empty_task: {
        provider: 'auto',
        timeout: 30,
      },
    })
  })

  it('updates only delegation model routing fields and returns the normalized profile state', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), [
      'delegation:',
      '  provider: root-provider',
      '  model: root-model',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'delegation:',
      '  provider: old-provider',
      '  model: old-model',
      '  reasoning_effort: low',
      '  base_url: https://old-delegation.example/v1',
      '  api_key: old-delegation-key',
      '  api_mode: chat_completions',
      '  max_iterations: 42',
      '  max_concurrent_children: 5',
      '',
    ].join('\n'), 'utf-8')

    const { getDelegationModel, updateDelegationModel } = await loadController()
    const readCtx = makeCtx({}, 'research')
    await getDelegationModel(readCtx)
    expect(readCtx.body).toEqual({
      delegation: {
        provider: 'old-provider',
        model: 'old-model',
        reasoning_effort: 'low',
      },
    })

    const writeCtx = makeCtx({
      delegation: {
        provider: ' openrouter ',
        model: ' google/gemini-3-flash-preview ',
        reasoning_effort: ' high ',
        max_iterations: 999,
      },
    }, 'research')
    await updateDelegationModel(writeCtx)
    expect(writeCtx.body).toEqual({
      success: true,
      delegation: {
        provider: 'openrouter',
        model: 'google/gemini-3-flash-preview',
        reasoning_effort: 'high',
      },
    })

    const updatedConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(updatedConfig.delegation).toEqual({
      provider: 'openrouter',
      model: 'google/gemini-3-flash-preview',
      reasoning_effort: 'high',
      max_iterations: 42,
      max_concurrent_children: 5,
    })
    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.delegation).toEqual({ provider: 'root-provider', model: 'root-model' })

    const invalidCtx = makeCtx({ delegation: { reasoning_effort: 'extreme' } }, 'research')
    await updateDelegationModel(invalidCtx)
    expect(invalidCtx.status).toBe(400)
    expect(invalidCtx.body).toEqual({ error: 'Invalid delegation model config' })

    const resetCtx = makeCtx({ delegation: {} }, 'research')
    await updateDelegationModel(resetCtx)
    expect(resetCtx.body).toEqual({ success: true, delegation: {} })
    const resetConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(resetConfig.delegation).toEqual({
      max_iterations: 42,
      max_concurrent_children: 5,
    })
  })

  it('clears only allowlisted channel credentials and keeps access controls and endpoints', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'platforms:',
      '  telegram:',
      '    token: yaml-token',
      '    proxy: socks5://config-proxy',
      '    allowed_users: user-1,user-2',
      '    allow_all_users: false',
      '    extra:',
      '      base_url: https://telegram.example',
      'model:',
      '  default: glm-5.1',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(hermesHome, '.env'), [
      'OPENROUTER_API_KEY=keep',
      'TELEGRAM_BOT_TOKEN=env-token',
      'TELEGRAM_PROXY=socks5://env-proxy',
      '',
    ].join('\n'), 'utf-8')
    const { clearCredentials, getConfig } = await loadController()

    const beforeCtx = makeCtx({})
    await getConfig(beforeCtx)
    expect(beforeCtx.body.platformCredentialStatus.telegram).toBe(true)

    const ctx = makeCtx({})
    ctx.params = { platform: 'telegram' }
    await clearCredentials(ctx)

    expect(ctx.body).toEqual({
      success: true,
      platform: 'telegram',
      clearedPaths: ['token', 'proxy'],
      gatewayRestarted: true,
    })
    expect(mockRestartGateway).toHaveBeenCalledWith('default')

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN=')
    expect(env).not.toContain('TELEGRAM_PROXY=')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.telegram.token).toBeUndefined()
    expect(config.platforms.telegram.proxy).toBeUndefined()
    expect(config.platforms.telegram.allowed_users).toBe('user-1,user-2')
    expect(config.platforms.telegram.allow_all_users).toBe(false)
    expect(config.platforms.telegram.extra.base_url).toBe('https://telegram.example')
    expect(config.model.default).toBe('glm-5.1')

    const afterCtx = makeCtx({})
    await getConfig(afterCtx)
    expect(afterCtx.body.platformCredentialStatus.telegram).toBe(false)

    const secondCtx = makeCtx({})
    secondCtx.params = { platform: 'telegram' }
    await clearCredentials(secondCtx)
    expect(secondCtx.body).toEqual({
      success: true,
      platform: 'telegram',
      clearedPaths: [],
      gatewayRestarted: false,
    })
    expect(mockRestartGateway).toHaveBeenCalledTimes(1)
  })

  it('clears credentials only in the requested profile', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), 'platforms:\n  telegram:\n    token: default-config-token\n', 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'TELEGRAM_BOT_TOKEN=default-token\n', 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), [
      'platforms:',
      '  telegram:',
      '    token: research-config-token',
      '    allowed_users: research-user',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(researchDir, '.env'), 'TELEGRAM_BOT_TOKEN=research-token\n', 'utf-8')
    const { clearCredentials } = await loadController()

    const ctx = makeCtx({}, 'research')
    ctx.params = { platform: 'telegram' }
    await clearCredentials(ctx)

    expect(ctx.body.clearedPaths).toEqual(['token'])
    expect(mockRestartGateway).toHaveBeenCalledWith('research')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toContain('TELEGRAM_BOT_TOKEN=default-token')
    expect(await readFile(join(researchDir, '.env'), 'utf-8')).not.toContain('TELEGRAM_BOT_TOKEN=')
    const defaultConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(defaultConfig.platforms.telegram.token).toBe('default-config-token')
    expect(researchConfig.platforms.telegram.token).toBeUndefined()
    expect(researchConfig.platforms.telegram.allowed_users).toBe('research-user')
  })

  it('reports a restart warning without restoring cleared credentials', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'platforms:\n  discord:\n    token: config-token\n', 'utf-8')
    await writeFile(join(hermesHome, '.env'), 'DISCORD_BOT_TOKEN=discord-token\n', 'utf-8')
    mockRestartGateway.mockRejectedValueOnce(new Error('restart failed'))
    const { clearCredentials } = await loadController()

    const ctx = makeCtx({})
    ctx.params = { platform: 'discord' }
    await clearCredentials(ctx)

    expect(ctx.body.success).toBe(true)
    expect(ctx.body.gatewayRestarted).toBe(false)
    expect(ctx.body.warning).toEqual({
      code: 'gateway_restart_failed',
      message: 'Credentials were cleared, but the gateway could not be restarted automatically.',
    })
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).not.toContain('DISCORD_BOT_TOKEN=')
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms?.discord?.token).toBeUndefined()
  })

  it('fails closed for a channel without an explicit credential allowlist', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'platforms:\n  whatsapp:\n    enabled: true\n', 'utf-8')
    const { clearCredentials } = await loadController()

    const ctx = makeCtx({})
    ctx.params = { platform: 'whatsapp' }
    await clearCredentials(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Unsupported credential clearing platform: whatsapp' })
    expect(mockRestartGateway).not.toHaveBeenCalled()
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.platforms.whatsapp.enabled).toBe(true)
  })

})
