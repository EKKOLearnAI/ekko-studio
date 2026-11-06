import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(), save: vi.fn(), resolveToken: vi.fn(), readYaml: vi.fn(), readApp: vi.fn(), readFile: vi.fn(),
}))
vi.mock('child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: mocks.exec }),
}))
vi.mock('fs/promises', () => ({ mkdir: vi.fn(), readFile: mocks.readFile }))
vi.mock('../../packages/server/src/modules/studio/public/safe-file-store', () => ({ safeFileStore: { readYaml: mocks.readYaml } }))
vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({ readAppConfig: mocks.readApp }))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', () => ({ saveEnvValueInHome: mocks.save }))
vi.mock('../../packages/server/src/modules/hermes/services/providers/copilot-models', () => ({ resolveCopilotOAuthTokenWithSource: mocks.resolveToken }))

import { prepareConfiguredCopilotRuntime, prepareCopilotRuntime } from '../../packages/server/src/modules/hermes/services/providers/copilot-runtime'

const command = { command: '/bundle/python', argsPrefix: [], agentRoot: '/bundle/source', hermesHome: '/data/profiles/work' }
const status = (needs_plugin: boolean, present = false) => ({ stdout: JSON.stringify({ needs_plugin, present, hint: 'Copilot plugin needs attention' }), stderr: '' })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.readFile.mockResolvedValue('COPILOT_GITHUB_TOKEN=profile-token')
  mocks.resolveToken.mockResolvedValue({ token: 'profile-token', source: 'apps-json' })
  mocks.exec.mockResolvedValue(status(false))
  mocks.readYaml.mockResolvedValue({ model: { provider: 'copilot' } })
  mocks.readApp.mockResolvedValue({ copilotEnabled: false })
})

describe('Copilot runtime activation', () => {
  it('keeps core providers working and copies an accepted external login into only the selected home', async () => {
    await prepareCopilotRuntime(command)
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.resolveToken).toHaveBeenCalledWith(expect.any(String), { inheritProcessEnv: false })
    expect(mocks.save).toHaveBeenCalledWith(command.hermesHome, 'COPILOT_GITHUB_TOKEN', 'profile-token')
    expect(process.env.COPILOT_GITHUB_TOKEN).not.toBe('profile-token')
  })

  it('installs and verifies the migrated provider before accepting its credential', async () => {
    mocks.exec.mockResolvedValueOnce(status(true)).mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce(status(false))
    await prepareCopilotRuntime(command, { token: 'new-oauth-token', enableDisabled: true })
    expect(mocks.exec.mock.calls[1][1]).toEqual(['-m', 'hermes_cli.main', 'plugins', 'install', 'github-copilot', '--yes'])
    expect(mocks.exec.mock.calls[1][2].env.HERMES_HOME).toBe(command.hermesHome)
    expect(mocks.save).toHaveBeenCalledWith(command.hermesHome, 'COPILOT_GITHUB_TOKEN', 'new-oauth-token')
  })

  it('does not publish credentials or accept a plugin whose installation failed', async () => {
    mocks.exec.mockResolvedValueOnce(status(true)).mockRejectedValueOnce(new Error('offline'))
    await expect(prepareCopilotRuntime(command)).rejects.toThrow('offline')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('rejects a plugin which still cannot be loaded after installation', async () => {
    mocks.exec.mockResolvedValueOnce(status(true)).mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce(status(true, true))
    await expect(prepareCopilotRuntime(command)).rejects.toThrow('Copilot plugin needs attention')
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('enables a disabled plugin only for explicit activation', async () => {
    mocks.exec.mockResolvedValueOnce(status(true, true)).mockResolvedValueOnce({ stdout: '', stderr: '' }).mockResolvedValueOnce(status(false))
    await prepareCopilotRuntime(command, { enableDisabled: true })
    expect(mocks.exec.mock.calls[1][1]).toEqual(['-m', 'hermes_cli.main', 'plugins', 'enable', 'github-copilot'])
    expect(mocks.save).toHaveBeenCalledOnce()
  })

  it('preserves an intentionally disabled plugin during startup', async () => {
    mocks.exec.mockResolvedValue(status(true, true))
    await expect(prepareConfiguredCopilotRuntime(command)).rejects.toThrow('Copilot plugin needs attention')
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('honors the profile prohibition on lazy installs during startup', async () => {
    mocks.readYaml.mockResolvedValue({ model: { provider: 'copilot' }, security: { allow_lazy_installs: false } })
    mocks.exec.mockResolvedValue(status(true))
    await expect(prepareConfiguredCopilotRuntime(command)).rejects.toThrow('Copilot plugin needs attention')
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('prepares a previously enabled provider even when the default model uses another provider', async () => {
    mocks.readYaml.mockResolvedValue({ model: { provider: 'custom' } })
    mocks.readApp.mockResolvedValue({ copilotEnabled: true })
    await prepareConfiguredCopilotRuntime(command)
    expect(mocks.save).toHaveBeenCalledWith(command.hermesHome, 'COPILOT_GITHUB_TOKEN', 'profile-token')
  })

  it('does not install optional providers in a profile that never enabled them', async () => {
    mocks.readYaml.mockResolvedValue({ model: { provider: 'custom' } })
    await prepareConfiguredCopilotRuntime(command)
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
