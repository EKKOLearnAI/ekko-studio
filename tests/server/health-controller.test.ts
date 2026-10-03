import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readRootPackage() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    name: string
    version: string
  }
}

type LoadHealthControllerOptions = {
  injectedVersion?: string
  isDocker?: boolean
  isGitClone?: boolean
  disableUpdateCheck?: boolean
  bridgeReadiness?: any
  bridgeReadinessError?: Error
  managerError?: Error
  runtimeStateError?: Error
}

const defaultBridgeReadiness = {
  endpoint: 'tcp://127.0.0.1:8123',
  endpointKind: 'tcp',
  status: 'ready',
  reachable: true,
  ready: true,
  running: true,
  attached: false,
  starting: false,
  stopping: false,
  restartScheduled: false,
  restartAttempts: 0,
  pid: 4321,
}

async function loadHealthController(options: LoadHealthControllerOptions = {}) {
  vi.resetModules()
  vi.stubEnv('HERMES_WEB_UI_DISABLE_UPDATE_CHECK', options.disableUpdateCheck ? 'true' : '')

  if (typeof options.injectedVersion === 'string') {
    ;(globalThis as any).__APP_VERSION__ = options.injectedVersion
  } else {
    delete (globalThis as any).__APP_VERSION__
  }

  const getVersion = vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n')
  vi.doMock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
    getVersion,
  }))

  const checkReadiness = options.bridgeReadinessError
    ? vi.fn().mockRejectedValue(options.bridgeReadinessError)
    : vi.fn().mockResolvedValue(options.bridgeReadiness || defaultBridgeReadiness)
  const getRuntimeState = options.runtimeStateError
    ? vi.fn(() => { throw options.runtimeStateError })
    : vi.fn(() => ({
        endpoint: options.bridgeReadiness?.endpoint || 'ipc:///tmp/hermes-agent-bridge.sock',
      }))
  const getAgentBridgeManager = options.managerError
    ? vi.fn(() => { throw options.managerError })
    : vi.fn(() => ({ checkReadiness, getRuntimeState }))

  vi.doMock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
    getAgentBridgeManager,
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/runtime-environment', () => ({
    isDockerContainer: () => options.isDocker === true,
    isGitCloneDeployment: () => options.isGitClone === true,
  }))

  const health = await import('../../packages/server/src/bootstrap/health')

  return {
    ...health,
    getVersion,
    getAgentBridgeManager,
    checkReadiness,
    getRuntimeState,
  }
}

async function loadHealthControllerWithoutInjectedVersion(options: Omit<LoadHealthControllerOptions, 'injectedVersion'> = {}) {
  return loadHealthController(options)
}

async function loadHealthControllerWithInjectedVersion(version: string) {
  return loadHealthController({ injectedVersion: version })
}

function createMockCtx() {
  return {
    body: null as any,
  }
}

describe('liveness controller', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns a static ok response without probing Hermes or Agent Bridge', async () => {
    const { livenessCheck, getVersion, getAgentBridgeManager } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    livenessCheck(ctx)

    expect(ctx.body).toEqual({ status: 'ok' })
    expect(getVersion).not.toHaveBeenCalled()
    expect(getAgentBridgeManager).not.toHaveBeenCalled()
  })
})

describe('health controller version metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
  })

  it('reads the root package version in ts-node/dev mode instead of falling back to 0.0.0', async () => {
    const pkg = readRootPackage()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe(pkg.version)
    expect(ctx.body.webui_version).not.toBe('0.0.0')
  })

  it('uses the injected build version when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe('9.9.9-test')
  })

  it('checks npm latest using the root package name', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const pkg = readRootPackage()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '99.99.99' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithoutInjectedVersion()

    await checkLatestVersion()

    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${pkg.name}/latest`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('99.99.99')
    expect(ctx.body.webui_update_available).toBe(true)
  })

  it('does not report a registry version lower than the local build as an update', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '0.6.17' }),
    }))

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.18')

    await checkLatestVersion()

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('0.6.17')
    expect(ctx.body.webui_update_available).toBe(false)
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Update available'))
  })

  it('does not throw when latest-version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion } = await loadHealthControllerWithoutInjectedVersion()

    await expect(checkLatestVersion()).resolves.toBeUndefined()
  })

  it('skips npm latest when update checks are explicitly disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthController({ disableUpdateCheck: true })

    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ctx.body.webui_latest).toBe('')
    expect(ctx.body.webui_update_available).toBe(false)
  })

  it('reports Docker while retaining version checks for upgrade guidance', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '0.6.29' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkLatestVersion, healthCheck } = await loadHealthController({
      injectedVersion: '0.6.28',
      isDocker: true,
    })

    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(ctx.body).toEqual(expect.objectContaining({
      is_docker: true,
      webui_latest: '0.6.29',
      webui_update_available: true,
    }))
  })

  it('flags a git checkout and suppresses registry-driven update prompts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '0.6.29' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { checkLatestVersion, healthCheck } = await loadHealthController({
      injectedVersion: '0.6.28',
      isGitClone: true,
    })

    await checkLatestVersion()
    const ctx = createMockCtx()
    await healthCheck(ctx)

    // A git checkout upgrades from the repository, so a newer registry release
    // must not be advertised as an available update.
    expect(ctx.body).toEqual(expect.objectContaining({
      is_git_clone: true,
      is_docker: false,
      webui_latest: '',
      webui_update_available: false,
    }))
  })

  it('includes sanitized agent bridge readiness fields without leaking the endpoint path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getAgentBridgeManager, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      bridgeReadiness: {
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
        endpointKind: 'ipc',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: true,
        restartAttempts: 3,
        pid: 9876,
        error: 'connect ENOENT /tmp/hermes-agent-bridge.sock',
      },
    })
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(getAgentBridgeManager).toHaveBeenCalledTimes(1)
    expect(checkReadiness).toHaveBeenCalledWith({ timeoutMs: 75, connectRetryMs: 0 })
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restart_scheduled: true,
      restart_attempts: 3,
      endpoint_kind: 'ipc',
      pid: 9876,
      error: 'connect ENOENT [redacted endpoint]',
    })
    expect(ctx.body.agent_bridge).not.toHaveProperty('endpoint')
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('/tmp/hermes-agent-bridge.sock')
  })

  it('handles agent bridge readiness probe errors without failing the health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, checkReadiness, getRuntimeState } = await loadHealthControllerWithoutInjectedVersion({
      bridgeReadinessError: new Error('bridge manager unavailable at ipc:///tmp/hermes-agent-bridge.sock (ENOENT /tmp/hermes-agent-bridge.sock)'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(checkReadiness).toHaveBeenCalledWith({ timeoutMs: 75, connectRetryMs: 0 })
    expect(getRuntimeState).toHaveBeenCalledTimes(1)
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.gateway).toBe('running')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'bridge manager unavailable at [redacted endpoint] (ENOENT [redacted endpoint])',
    })
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('/tmp/hermes-agent-bridge.sock')
    expect(JSON.stringify(ctx.body.agent_bridge)).not.toContain('ipc:///tmp/hermes-agent-bridge.sock')
  })

  it('handles manager construction errors without failing the base health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getAgentBridgeManager, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      managerError: new Error('bad bridge config /tmp/hermes-agent-bridge.sock'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(getAgentBridgeManager).toHaveBeenCalledTimes(1)
    expect(checkReadiness).not.toHaveBeenCalled()
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'bad bridge config [redacted endpoint]',
    })
  })

  it('handles runtime-state errors without failing the base health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck, getRuntimeState, checkReadiness } = await loadHealthControllerWithoutInjectedVersion({
      runtimeStateError: new Error('runtime state unavailable'),
    })
    const ctx = createMockCtx()

    await expect(healthCheck(ctx)).resolves.toBeUndefined()

    expect(getRuntimeState).toHaveBeenCalledTimes(1)
    expect(checkReadiness).not.toHaveBeenCalled()
    expect(ctx.body.status).toBe('ok')
    expect(ctx.body.agent_bridge).toEqual({
      status: 'unknown',
      reachable: false,
      error: 'runtime state unavailable',
    })
  })

})
