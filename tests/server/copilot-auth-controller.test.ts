import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => '/fake/home' }
})

const { mockReadFile, mockWriteFile, mockMkdir, mockSaveEnvValue, mockReadConfigYaml, mockWriteConfigYaml, mockUpdateConfigYaml, mockResolveWithSource, mockInvalidate, mockReadAppConfig, mockWriteAppConfig } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockSaveEnvValue: vi.fn().mockResolvedValue(undefined),
  mockReadConfigYaml: vi.fn(),
  mockWriteConfigYaml: vi.fn().mockResolvedValue(undefined),
  mockUpdateConfigYaml: vi.fn(),
  mockResolveWithSource: vi.fn(),
  mockInvalidate: vi.fn(),
  mockReadAppConfig: vi.fn(),
  mockWriteAppConfig: vi.fn().mockResolvedValue({ copilotEnabled: true }),
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  saveEnvValue: mockSaveEnvValue,
  readConfigYaml: mockReadConfigYaml,
  writeConfigYaml: mockWriteConfigYaml,
  updateConfigYaml: mockUpdateConfigYaml,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({
  resolveCopilotOAuthTokenWithSource: mockResolveWithSource,
  invalidateAllCaches: mockInvalidate,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveEnvPath: () => '/fake/home/.hermes/.env',
}))

vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: mockReadAppConfig,
  writeAppConfig: mockWriteAppConfig,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import * as ctrl from '../../packages/server/src/modules/hermes/controllers/copilot-auth'

function makeCtx(): any {
  return { params: {}, request: { body: {} }, body: undefined, status: 200 }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadFile.mockResolvedValue('')
  mockReadConfigYaml.mockResolvedValue({})
  mockUpdateConfigYaml.mockImplementation(async (updater: any) => {
    const cfg = await mockReadConfigYaml()
    const updated = await updater(cfg)
    if (updated && typeof updated === 'object' && Object.hasOwn(updated, 'data')) {
      if (updated.write === false) return updated.result
      await mockWriteConfigYaml(updated.data)
      return updated.result
    }
    await mockWriteConfigYaml(updated)
    return undefined
  })
})

afterEach(() => {
  delete process.env.COPILOT_GITHUB_TOKEN
})

describe('copilot-auth controller — checkToken', () => {
  it('reports has_token=false / source=null / enabled=false when nothing resolves', async () => {
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    mockReadAppConfig.mockResolvedValue({})
    const ctx = makeCtx()
    await ctrl.checkToken(ctx)
    expect(ctx.body).toEqual({ has_token: false, source: null, enabled: false })
    expect(mockInvalidate).toHaveBeenCalled()
  })

  it('reports source and enabled flag', async () => {
    mockResolveWithSource.mockResolvedValue({ token: 'gho_xxx', source: 'env' })
    mockReadAppConfig.mockResolvedValue({ copilotEnabled: true })
    const ctx = makeCtx()
    await ctrl.checkToken(ctx)
    expect(ctx.body).toEqual({ has_token: true, source: 'env', enabled: true })
  })
})

describe('copilot-auth controller — enable', () => {
  it('persists copilotEnabled=true and invalidates cache', async () => {
    const ctx = makeCtx()
    await ctrl.enable(ctx)
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ copilotEnabled: true })
    expect(mockInvalidate).toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })
})

describe('copilot-auth controller — disable', () => {
  it('clears ~/.hermes/.env when token source is env', async () => {
    mockResolveWithSource.mockResolvedValue({ token: 'gho_xxx', source: 'env' })
    process.env.COPILOT_GITHUB_TOKEN = 'gho_xxx'
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockSaveEnvValue).toHaveBeenCalledWith('COPILOT_GITHUB_TOKEN', '')
    expect(process.env.COPILOT_GITHUB_TOKEN).toBeUndefined()
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ copilotEnabled: false })
    expect(ctx.body).toEqual({ ok: true, cleared_env: true, cleared_default: false })
  })

  it('does NOT touch .env when token source is gh-cli (preserves gh CLI session)', async () => {
    mockResolveWithSource.mockResolvedValue({ token: 'gho_xxx', source: 'gh-cli' })
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockSaveEnvValue).not.toHaveBeenCalled()
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ copilotEnabled: false })
    expect(ctx.body).toEqual({ ok: true, cleared_env: false, cleared_default: false })
  })

  it('does NOT touch .env when token source is apps-json (preserves VS Code Copilot)', async () => {
    mockResolveWithSource.mockResolvedValue({ token: 'gho_xxx', source: 'apps-json' })
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockSaveEnvValue).not.toHaveBeenCalled()
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ copilotEnabled: false })
    expect(ctx.body).toEqual({ ok: true, cleared_env: false, cleared_default: false })
  })

  it('still flips enabled=false even when no token is resolvable', async () => {
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockSaveEnvValue).not.toHaveBeenCalled()
    expect(mockWriteAppConfig).toHaveBeenCalledWith({ copilotEnabled: false })
  })

  it('clears default model when it belongs to copilot', async () => {
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    mockReadConfigYaml.mockResolvedValue({ model: { default: 'gpt-4o', provider: 'copilot' } })
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockWriteConfigYaml).toHaveBeenCalledWith(expect.objectContaining({ model: {} }))
    expect(ctx.body).toEqual(expect.objectContaining({ cleared_default: true }))
  })

  it('preserves provider-independent model settings when disabling copilot', async () => {
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    mockReadConfigYaml.mockResolvedValue({ model: {
      default: 'gpt-4o',
      provider: 'copilot',
      context_length: 256000,
    } })
    const ctx = makeCtx()

    await ctrl.disable(ctx)

    expect(mockWriteConfigYaml).toHaveBeenCalledWith({ model: { context_length: 256000 } })
  })

  it('does NOT touch default model when it belongs to a different provider', async () => {
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    mockReadConfigYaml.mockResolvedValue({ model: { default: 'glm-4', provider: 'zhipu' } })
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(mockWriteConfigYaml).not.toHaveBeenCalled()
    expect(ctx.body).toEqual(expect.objectContaining({ cleared_default: false }))
  })

  it('returns 500 and does NOT flip enabled flag when writeConfigYaml fails', async () => {
    mockResolveWithSource.mockResolvedValue({ token: 'gho_xxx', source: 'env' })
    mockReadConfigYaml.mockResolvedValue({ model: { default: 'gpt-4o', provider: 'copilot' } })
    mockWriteConfigYaml.mockRejectedValueOnce(new Error('disk full'))
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    expect(ctx.status).toBe(500)
    expect(mockSaveEnvValue).not.toHaveBeenCalled()
    expect(mockWriteAppConfig).not.toHaveBeenCalled()
  })

  it('does not write process.env on persistToken / disable cleanup is defensive only', async () => {
    // disable 不依赖 process.env 被写入；只清理之前可能由外部 export 的覆盖。
    mockResolveWithSource.mockResolvedValue({ token: '', source: null })
    process.env.COPILOT_GITHUB_TOKEN = 'leftover-from-shell'
    const ctx = makeCtx()
    await ctrl.disable(ctx)
    // source=null → 不动 .env，也不清 process.env（因为不是 web-ui 自己的状态）
    expect(process.env.COPILOT_GITHUB_TOKEN).toBe('leftover-from-shell')
  })
})
