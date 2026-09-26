import { EventEmitter } from 'events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockManagedChild = EventEmitter & {
  pid: number
  killed: boolean
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function createMockManagedChild(pid: number): MockManagedChild {
  const child = new EventEmitter() as MockManagedChild
  child.pid = pid
  child.killed = false
  child.kill = vi.fn((signal: string) => {
    child.killed = signal === 'SIGTERM' || signal === 'SIGKILL'
    return true
  })
  child.unref = vi.fn()
  return child
}

async function listenOnRandomTcpPort(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error)
    server.once('error', handleError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', handleError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected the test TCP server to expose a numeric port')
  }
  return `tcp://127.0.0.1:${address.port}`
}

describe('agent bridge manager command resolution', () => {
  const originalEnv = { ...process.env }
  let tempDir = ''

  beforeEach(() => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-agent-bridge-manager-'))
    process.env = { ...originalEnv }
    delete process.env.HERMES_AGENT_ROOT
    delete process.env.HERMES_AGENT_BRIDGE_PYTHON
    delete process.env.HERMES_AGENT_BRIDGE_UV
    delete process.env.UV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('prefers the Ekko Studio bundled runtime env over a user-installed Hermes command', async () => {
    const bundledRoot = join(tempDir, 'studio-runtime')
    const bundledPython = join(bundledRoot, 'bin', 'python3')
    const installedBin = join(tempDir, 'user-install', 'bin')
    const installedPython = join(installedBin, 'python3')
    const installedHermes = join(installedBin, 'hermes')
    const studioHome = join(tempDir, 'studio-home')
    mkdirSync(join(bundledRoot, 'bin'), { recursive: true })
    mkdirSync(installedBin, { recursive: true })
    mkdirSync(studioHome, { recursive: true })
    writeFileSync(join(bundledRoot, 'run_agent.py'), '')
    writeFileSync(bundledPython, '#!/bin/sh\n')
    writeFileSync(installedPython, '#!/bin/sh\n')
    writeFileSync(installedHermes, `#!${installedPython}\n`)
    chmodSync(bundledPython, 0o755)
    chmodSync(installedPython, 0o755)
    chmodSync(installedHermes, 0o755)
    process.env.HERMES_AGENT_ROOT = bundledRoot
    process.env.HERMES_AGENT_BRIDGE_PYTHON = bundledPython
    process.env.HERMES_BIN = installedHermes
    process.env.HERMES_HOME = studioHome

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    expect(resolveAgentBridgeCommand()).toEqual({
      command: bundledPython,
      argsPrefix: [],
      agentRoot: bundledRoot,
      hermesHome: studioHome,
    })
  })

  it('uses the installed hermes command Python when no source root exists', async () => {
    const binDir = join(tempDir, 'bin')
    const homeDir = join(tempDir, 'home')
    const fakePython = join(binDir, 'python')
    const fakeHermes = join(binDir, 'hermes')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = fakeHermes

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command).toEqual({
      command: fakePython,
      argsPrefix: [],
      agentRoot: undefined,
      hermesHome: homeDir,
    })
  })

  it('uses the Python beside a shell-wrapped hermes command', async () => {
    const binDir = join(tempDir, 'bin')
    const homeDir = join(tempDir, 'home')
    const siblingPython = join(binDir, process.platform === 'win32' ? 'python3.exe' : 'python3')
    const shellWrappedHermes = join(binDir, 'hermes')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(siblingPython, '#!/bin/sh\n')
    chmodSync(siblingPython, 0o755)
    writeFileSync(shellWrappedHermes, '#!/bin/sh\nexec "$(dirname "$0")/python3" "$0" "$@"\n')
    chmodSync(shellWrappedHermes, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = shellWrappedHermes

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')

    expect(resolveAgentBridgeCommand()).toEqual({
      command: siblingPython,
      argsPrefix: [],
      agentRoot: undefined,
      hermesHome: homeDir,
    })
  })

  it('discovers hermes-agent from a global lib install next to the hermes command', async () => {
    const installDir = join(tempDir, 'usr', 'local')
    const binDir = join(installDir, 'bin')
    const agentRoot = join(installDir, 'lib', 'hermes-agent')
    const fakePython = join(binDir, 'python')
    const fakeHermes = join(binDir, 'hermes')
    const homeDir = join(tempDir, 'home')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(agentRoot, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(join(agentRoot, 'run_agent.py'), '')
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    writeFileSync(fakeHermes, `#!${fakePython}\n`)
    chmodSync(fakeHermes, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = fakeHermes

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command.agentRoot).toBe(agentRoot)
  })

  it('falls back to system Python instead of uv when no source root exists', async () => {
    const homeDir = join(tempDir, 'home')
    const fakePython = join(tempDir, 'python3')
    mkdirSync(homeDir, { recursive: true })
    writeFileSync(fakePython, '#!/bin/sh\n')
    chmodSync(fakePython, 0o755)
    process.env.HERMES_HOME = homeDir
    process.env.HERMES_BIN = join(tempDir, 'missing-hermes')
    process.env.PYTHON = fakePython

    const { resolveAgentBridgeCommand } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const command = resolveAgentBridgeCommand()

    expect(command).toEqual({
      command: fakePython,
      argsPrefix: [],
      agentRoot: undefined,
      hermesHome: homeDir,
    })
  })

  it('injects Web UI OpenRouter attribution into the bridge process env by default', async () => {
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', '/tmp/hermes-agent')

    expect(env.HERMES_OPENROUTER_APP_REFERER).toBe('https://ekkostudio.xyz')
    expect(env.HERMES_OPENROUTER_APP_TITLE).toBe('Ekko Studio')
    expect(env.HERMES_OPENROUTER_APP_CATEGORIES).toBe('cli-agent,personal-agent')
  })

  it('keeps explicit OpenRouter attribution env values when starting the bridge', async () => {
    process.env.HERMES_OPENROUTER_APP_REFERER = 'https://example.invalid/app'
    process.env.HERMES_OPENROUTER_APP_TITLE = 'Custom App'
    process.env.HERMES_OPENROUTER_APP_CATEGORIES = 'custom-category'

    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', undefined)

    expect(env.HERMES_OPENROUTER_APP_REFERER).toBe('https://example.invalid/app')
    expect(env.HERMES_OPENROUTER_APP_TITLE).toBe('Custom App')
    expect(env.HERMES_OPENROUTER_APP_CATEGORIES).toBe('custom-category')
  })

  it('binds managed MCP launches to this server even when inherited routing is stale', async () => {
    process.env.PORT = '18748'
    process.env.HERMES_WEB_UI_HOME = join(tempDir, 'owner-state')
    process.env.HERMES_WEB_UI_URL = 'http://127.0.0.1:18647'
    process.env.HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV = JSON.stringify({ HERMES_WEB_UI_URL: 'http://127.0.0.1:18647' })
    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', undefined)
    expect(JSON.parse(env.HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV!)).toEqual({
      HERMES_WEB_UI_URL: 'http://127.0.0.1:18748',
      HERMES_WEB_UI_HOME: join(tempDir, 'owner-state'),
      HERMES_WEBUI_STATE_DIR: join(tempDir, 'owner-state'),
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('removes inherited Anthropic auth token from the bridge process env', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'stale-bearer-token'

    const { buildAgentBridgeProcessEnv } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const env = buildAgentBridgeProcessEnv('ipc:///tmp/test.sock', '/tmp/hermes-home', undefined)

    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  })

  it('uses an isolated default bridge endpoint while running under Vitest', async () => {
    const { DEFAULT_AGENT_BRIDGE_ENDPOINT } = await import('../../packages/server/src/modules/hermes/services/bridge/client')

    if (process.platform === 'win32') {
      expect(DEFAULT_AGENT_BRIDGE_ENDPOINT).toBe(`tcp://127.0.0.1:${28000 + (process.pid % 10000)}`)
    } else {
      expect(DEFAULT_AGENT_BRIDGE_ENDPOINT).toContain(`hermes-agent-bridge-test-${process.pid}`)
    }
    expect(DEFAULT_AGENT_BRIDGE_ENDPOINT).not.toBe('ipc:///tmp/hermes-agent-bridge.sock')
  })

  it('honors the bridge connect retry environment override', async () => {
    process.env.HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS = '120000'

    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1' })

    expect(client.connectRetryMs).toBe(120000)
  })

  it('waits briefly for a restarting bridge socket before failing', async () => {
    const endpoint = `tcp://127.0.0.1:${32000 + (process.pid % 10000)}`
    let server: Server | undefined

    const ready = new Promise<void>((resolve) => {
      setTimeout(() => {
        server = createServer((socket) => {
          socket.once('data', () => {
            socket.end(`${JSON.stringify({ ok: true, pong: true })}\n`)
          })
        })
        if (endpoint.startsWith('ipc://')) {
          server.listen(endpoint.slice('ipc://'.length), resolve)
        } else {
          const url = new URL(endpoint)
          server.listen(Number(url.port), url.hostname, resolve)
        }
      }, 150)
    })

    try {
      const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
      const client = new AgentBridgeClient({ endpoint, connectRetryMs: 1000, timeoutMs: 1000 })
      await expect(client.ping()).resolves.toMatchObject({ ok: true, pong: true })
      await ready
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    }
  })

  it('reports readiness when a fake TCP server answers ping with pong', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ ok: true, pong: true })}\n`)
      })
    })
    const endpoint = await listenOnRandomTcpPort(server)

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint })

      await expect(manager.checkReadiness({ timeoutMs: 250, connectRetryMs: 0 })).resolves.toMatchObject({
        endpoint,
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
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports unreachable instead of throwing when endpoint is missing', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager()
    manager.endpoint = ''

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: '',
      endpointKind: 'unknown',
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      error: 'agent bridge endpoint is not configured',
    })
  })

  it('reports starting readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6553' })

    ;(manager as any).starting = Promise.resolve()

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6553',
      endpointKind: 'tcp',
      status: 'starting',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: true,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
    })
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('reports stopping readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6554' })

    ;(manager as any).attached = true
    ;(manager as any).ready = true
    ;(manager as any).stopping = true

    await expect(manager.checkReadiness()).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6554',
      endpointKind: 'tcp',
      status: 'stopping',
      reachable: false,
      ready: false,
      running: false,
      attached: true,
      starting: false,
      stopping: true,
      restartScheduled: false,
      restartAttempts: 0,
    })
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('reports restarting readiness without pinging the bridge', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6555' })

    ;(manager as any).restartAttempts = 2
    ;(manager as any).restartTimer = setTimeout(() => undefined, 1000)

    try {
      await expect(manager.checkReadiness()).resolves.toMatchObject({
        endpoint: 'tcp://127.0.0.1:6555',
        endpointKind: 'tcp',
        status: 'restarting',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: true,
        restartAttempts: 2,
      })
    } finally {
      clearTimeout((manager as any).restartTimer)
      ;(manager as any).restartTimer = null
    }

    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('schedules a restart when a managed bridge exits before ready', async () => {
    vi.useFakeTimers()
    process.env.HERMES_AGENT_BRIDGE_RESTART_DELAY_MS = '1000'
    const child = createMockManagedChild(45670)
    const spawnMock = vi.fn().mockReturnValue(child)

    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process')
      return {
        ...actual,
        spawn: spawnMock,
      }
    })

    try {
      const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
      vi.spyOn(AgentBridgeClient.prototype, 'ping').mockRejectedValue(new Error('bridge offline'))
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6564', startupTimeoutMs: 5000 })

      const starting = manager.start()
      for (let attempt = 0; attempt < 10 && spawnMock.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve()
      }
      expect(spawnMock).toHaveBeenCalledTimes(1)

      child.emit('exit', 2, null)

      await expect(starting).rejects.toThrow('agent bridge exited before ready code=2 signal=null')
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        restartScheduled: true,
        restartAttempts: 1,
      })
      manager.forceStop()
    } finally {
      vi.doUnmock('child_process')
      vi.useRealTimers()
    }
  })

  it('caps automatic restart attempts after startup failures', async () => {
    vi.useFakeTimers()
    process.env.HERMES_AGENT_BRIDGE_RESTART_DELAY_MS = '1'
    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6565' })
      const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('bridge startup failed'))

      ;(manager as any).scheduleRestart(null, null, true)
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(2)
      await vi.advanceTimersByTimeAsync(3)

      expect(startSpy).toHaveBeenCalledTimes(3)
      expect(manager.getRuntimeState()).toMatchObject({
        restartScheduled: false,
        restartAttempts: 3,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('attaches to an already running bridge instead of spawning a replacement', async () => {
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`)
      })
    })
    const endpoint = await listenOnRandomTcpPort(server)

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()

      expect(actions).toEqual(['ping'])
      expect(manager.getRuntimeState()).toMatchObject({
        endpoint,
        ready: true,
        running: true,
        attached: true,
        pid: undefined,
      })
      await manager.stop()
      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('requests shutdown when stopping an attached bridge', async () => {
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`)
      })
    })
    const endpoint = await listenOnRandomTcpPort(server)

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()
      await manager.stop()

      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('force-stops the complete managed bridge process tree', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6557' })
    const child = createMockManagedChild(45678)
    ;(manager as any).child = child
    ;(manager as any).ready = true
    const forceKillTree = vi.spyOn(manager as any, 'forceKillManagedChildTree').mockImplementation(() => {})

    manager.forceStop()

    expect(forceKillTree).toHaveBeenCalledWith(child)
    expect(manager.getRuntimeState()).toMatchObject({
      ready: false,
      running: false,
      attached: false,
      stopping: true,
      pid: undefined,
    })
  })

  it('force-kills the managed bridge tree when graceful shutdown times out', async () => {
    vi.useFakeTimers()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.HERMES_AGENT_BRIDGE_SHUTDOWN_TIMEOUT_MS = '25'
    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6556' })
      const child = createMockManagedChild(45679)
      ;(manager as any).child = child
      ;(manager as any).ready = true
      const forceKillTree = vi.spyOn(manager as any, 'forceKillManagedChildTree').mockImplementation(() => {})

      const stopping = manager.stop()
      await vi.advanceTimersByTimeAsync(25)

      expect(forceKillTree).toHaveBeenCalledWith(child)
      child.emit('exit', null, 'SIGKILL')
      await stopping
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        stopping: false,
        pid: undefined,
      })
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
      vi.useRealTimers()
    }
  })

  it('clears stopping after stop completes for an attached bridge', async () => {
    const actions: string[] = []
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim())
        actions.push(request.action)
        socket.end(`${JSON.stringify({ ok: true, pong: request.action === 'ping' })}\n`, () => {
          if (request.action === 'shutdown') {
            server.close()
          }
        })
      })
    })
    const serverClosed = new Promise<void>((resolve) => server.once('close', () => resolve()))
    const endpoint = await listenOnRandomTcpPort(server)

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint, startupTimeoutMs: 100 })

      await manager.start()
      await manager.stop()
      await serverClosed

      expect(actions).toEqual(['ping', 'shutdown'])
      expect(manager.getRuntimeState()).toMatchObject({
        ready: false,
        running: false,
        attached: false,
        stopping: false,
      })
      await expect(manager.checkReadiness({ timeoutMs: 250, connectRetryMs: 0 })).resolves.toMatchObject({
        endpoint,
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
      })
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })

  it('returns unreachable without attempting recovery when recover is false', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6556' })
    const readiness = {
      endpoint: 'tcp://127.0.0.1:6556',
      endpointKind: 'tcp' as const,
      status: 'unreachable' as const,
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      error: 'connect ECONNREFUSED',
    }
    const checkReadinessSpy = vi.spyOn(manager, 'checkReadiness').mockResolvedValue(readiness)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    await expect(manager.ensureReady({ recover: false })).resolves.toEqual(readiness)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('returns immediately when the bridge is already reachable', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6560' })
    const readiness = {
      endpoint: 'tcp://127.0.0.1:6560',
      endpointKind: 'tcp' as const,
      status: 'ready' as const,
      reachable: true,
      ready: true,
      running: true,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
    }
    const checkReadinessSpy = vi.spyOn(manager, 'checkReadiness').mockResolvedValue(readiness)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    await expect(manager.ensureReady()).resolves.toEqual(readiness)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('waits for an in-flight start before re-checking readiness', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6561' })
    let resolveStarting: (() => void) | undefined
    ;(manager as any).starting = new Promise<void>((resolve) => {
      resolveStarting = resolve
    })

    const checkReadinessSpy = vi.spyOn(manager, 'checkReadiness')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6561',
        endpointKind: 'tcp',
        status: 'starting',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: true,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
      })
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6561',
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
      })
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()

    expect(checkReadinessSpy).toHaveBeenCalledTimes(1)
    expect(startSpy).not.toHaveBeenCalled()

    resolveStarting?.()

    await expect(ensureReadyPromise).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6561',
      status: 'ready',
      reachable: true,
    })
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('bounds an in-flight start by caller timeout', async () => {
    vi.useFakeTimers()
    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6565' })
      ;(manager as any).starting = new Promise<void>(() => {})
      const checkReadinessSpy = vi.spyOn(manager, 'checkReadiness')
        .mockResolvedValueOnce({
          endpoint: 'tcp://127.0.0.1:6565',
          endpointKind: 'tcp',
          status: 'starting',
          reachable: false,
          ready: false,
          running: false,
          attached: false,
          starting: true,
          stopping: false,
          restartScheduled: false,
          restartAttempts: 0,
        })

      const ensureReadyPromise = manager.ensureReady({ timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)

      await expect(ensureReadyPromise).resolves.toMatchObject({
        endpoint: 'tcp://127.0.0.1:6565',
        status: 'starting',
        reachable: false,
      })
      expect(checkReadinessSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces callers onto an existing managed recovery', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6566' })
    const child = createMockManagedChild(45666)
    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    const unreachable = {
      endpoint: 'tcp://127.0.0.1:6566',
      endpointKind: 'tcp' as const,
      status: 'unreachable' as const,
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      pid: 45666,
      error: 'connect ECONNREFUSED',
    }
    const recovered = {
      ...unreachable,
      status: 'ready' as const,
      reachable: true,
      ready: true,
      running: true,
      error: undefined,
    }
    const checkReadinessSpy = vi.spyOn(manager, 'checkReadiness').mockResolvedValue(unreachable)
    let resolveRecovery: ((value: typeof recovered) => void) | undefined
    const recoveryDeferred = new Promise<typeof recovered>((resolve) => {
      resolveRecovery = resolve
    })
    const performRecoverySpy = vi.spyOn(manager as any, 'performManagedRecovery').mockReturnValue(recoveryDeferred)

    const first = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    const second = manager.ensureReady()
    await Promise.resolve()
    resolveRecovery?.(recovered)

    await expect(first).resolves.toBe(recovered)
    await expect(second).resolves.toBe(recovered)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(performRecoverySpy).toHaveBeenCalledTimes(1)
  })

  it('does not run destructive managed recovery on legacy global default endpoints', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    const child = createMockManagedChild(45667)
    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    vi.spyOn(manager, 'checkReadiness').mockResolvedValue({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      endpointKind: 'ipc',
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      pid: 45667,
      error: 'connect ENOENT /tmp/hermes-agent-bridge.sock',
    })
    const performRecoverySpy = vi.spyOn(manager as any, 'performManagedRecovery')
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    await expect(manager.ensureReady()).resolves.toMatchObject({
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      status: 'unreachable',
      reachable: false,
      error: expect.stringContaining('merge endpoint scoping before enabling recovery'),
    })
    expect(child.kill).not.toHaveBeenCalled()
    expect(performRecoverySpy).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()
    expect((manager as any).child).toBe(child)
  })

  it('waits for the old managed child to exit before starting replacement recovery', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6557' })
    const child = createMockManagedChild(12345)

    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6557',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        pid: 12345,
        error: 'connect ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6557',
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
      })
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(startSpy).not.toHaveBeenCalled()

    child.emit('exit', 0, 'SIGTERM')

    await expect(ensureReadyPromise).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6557',
      status: 'ready',
      reachable: true,
    })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect((manager as any).child).toBeNull()
  })

  it('does not restart managed recovery after an explicit stop wins the race', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6564' })
    const child = createMockManagedChild(12347)

    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6564',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        pid: 12347,
        error: 'connect ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6564',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        error: 'connect ECONNREFUSED',
      })
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(startSpy).not.toHaveBeenCalled()

    const stopPromise = manager.stop()
    await Promise.resolve()
    child.emit('exit', 0, 'SIGTERM')
    await stopPromise

    await expect(ensureReadyPromise).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6564',
      status: 'unreachable',
      reachable: false,
      ready: false,
      running: false,
    })
    expect(startSpy).not.toHaveBeenCalled()
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(checkReadinessSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ connectRetryMs: 0 }), true)
    expect((manager as any).child).toBeNull()
    expect(manager.getRuntimeState()).toMatchObject({
      ready: false,
      running: false,
      attached: false,
      stopping: false,
    })
  })

  it('bounds managed-child recovery by escalating to SIGKILL before starting replacement', async () => {
    vi.useFakeTimers()

    try {
      const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
      const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6563' })
      const child = createMockManagedChild(12346)

      ;(manager as any).child = child
      ;(manager as any).ready = true
      ;(manager as any).attached = false

      const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
        .mockResolvedValueOnce({
          endpoint: 'tcp://127.0.0.1:6563',
          endpointKind: 'tcp',
          status: 'unreachable',
          reachable: false,
          ready: false,
          running: false,
          attached: false,
          starting: false,
          stopping: false,
          restartScheduled: false,
          restartAttempts: 0,
          pid: 12346,
          error: 'connect ECONNREFUSED',
        })
        .mockResolvedValueOnce({
          endpoint: 'tcp://127.0.0.1:6563',
          endpointKind: 'tcp',
          status: 'unreachable',
          reachable: false,
          ready: false,
          running: false,
          attached: false,
          starting: false,
          stopping: false,
          restartScheduled: false,
          restartAttempts: 0,
          pid: 12346,
          error: 'connect ECONNREFUSED',
        })
      const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()

      const ensureReadyPromise = manager.ensureReady()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(startSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect(startSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)

      await expect(ensureReadyPromise).resolves.toMatchObject({
        endpoint: 'tcp://127.0.0.1:6563',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        error: expect.stringContaining('did not exit after SIGTERM/SIGKILL'),
      })
      expect(startSpy).not.toHaveBeenCalled()
      expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the exiting stale managed child while delaying replacement until exit', async () => {
    const oldChild = createMockManagedChild(45671)
    const replacementChild = createMockManagedChild(45672)
    const spawnMock = vi.fn()
      .mockReturnValueOnce(oldChild)
      .mockReturnValueOnce(replacementChild)

    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process')
      return {
        ...actual,
        spawn: spawnMock,
      }
    })

    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const pingSpy = vi.spyOn(AgentBridgeClient.prototype, 'ping')
    let pingCalls = 0
    pingSpy.mockImplementation(async () => {
      pingCalls += 1
      if (pingCalls === 1 || pingCalls === 3) {
        throw new Error('bridge offline')
      }
      return { ok: true, pong: true } as any
    })

    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6562', startupTimeoutMs: 100 })
    await manager.start()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(manager.getRuntimeState()).toMatchObject({
      ready: true,
      running: true,
      attached: false,
      pid: 45671,
    })

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6562',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        pid: 45671,
        error: 'connect ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6562',
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
        pid: 45672,
      })

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(oldChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawnMock).toHaveBeenCalledTimes(1)

    oldChild.emit('exit', 0, 'SIGTERM')

    await expect(ensureReadyPromise).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6562',
      status: 'ready',
      reachable: true,
      pid: 45672,
    })
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect((manager as any).child).toBe(replacementChild)
    expect(manager.getRuntimeState()).toMatchObject({
      ready: true,
      running: true,
      attached: false,
      pid: 45672,
      restartScheduled: false,
      restartAttempts: 0,
    })
  })

  it('returns follow-up reachable readiness when restart fails after the bridge comes up', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6558' })
    const child = createMockManagedChild(23456)
    const recoveredReadiness = {
      endpoint: 'tcp://127.0.0.1:6558',
      endpointKind: 'tcp' as const,
      status: 'ready' as const,
      reachable: true,
      ready: true,
      running: true,
      attached: false,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      pid: 23456,
    }

    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6558',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        pid: 23456,
        error: 'connect ECONNREFUSED',
      })
      .mockResolvedValueOnce(recoveredReadiness)
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('spawn EADDRINUSE'))

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    child.emit('exit', 0, 'SIGTERM')

    await expect(ensureReadyPromise).resolves.toEqual(recoveredReadiness)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(checkReadinessSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ connectRetryMs: 0 }), true)
    expect((manager as any).child).toBeNull()
  })

  it('keeps follow-up unreachable readiness while adding restart failure context', async () => {
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6559' })
    const child = createMockManagedChild(34567)

    ;(manager as any).child = child
    ;(manager as any).ready = true
    ;(manager as any).attached = false

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal')
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6559',
        endpointKind: 'tcp',
        status: 'unreachable',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: false,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 0,
        pid: 34567,
        error: 'connect ECONNREFUSED',
      })
      .mockResolvedValueOnce({
        endpoint: 'tcp://127.0.0.1:6559',
        endpointKind: 'tcp',
        status: 'starting',
        reachable: false,
        ready: false,
        running: false,
        attached: false,
        starting: true,
        stopping: false,
        restartScheduled: false,
        restartAttempts: 1,
        pid: 34568,
        error: 'bridge ping timed out',
      })
    const startSpy = vi.spyOn(manager, 'start').mockRejectedValue(new Error('spawn ENOENT'))

    const ensureReadyPromise = manager.ensureReady()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    child.emit('exit', 0, 'SIGTERM')

    await expect(ensureReadyPromise).resolves.toMatchObject({
      endpoint: 'tcp://127.0.0.1:6559',
      status: 'starting',
      reachable: false,
      ready: false,
      running: false,
      error: 'bridge ping timed out; start failed: spawn ENOENT',
    })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(checkReadinessSpy).toHaveBeenCalledTimes(2)
    expect(checkReadinessSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ connectRetryMs: 0 }), true)
    expect((manager as any).child).toBeNull()
  })

  it('preserves attached external bridge state when readiness becomes unreachable', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const { AgentBridgeManager } = await import('../../packages/server/src/modules/hermes/services/bridge/manager')
    const manager = new AgentBridgeManager({ endpoint: 'tcp://127.0.0.1:6558' })
    const readiness = {
      endpoint: 'tcp://127.0.0.1:6558',
      endpointKind: 'tcp' as const,
      status: 'unreachable' as const,
      reachable: false,
      ready: false,
      running: false,
      attached: true,
      starting: false,
      stopping: false,
      restartScheduled: false,
      restartAttempts: 0,
      error: 'connect ECONNREFUSED',
    }

    ;(manager as any).child = null
    ;(manager as any).attached = true
    ;(manager as any).ready = true

    const checkReadinessSpy = vi.spyOn(manager as any, 'checkReadinessInternal').mockResolvedValue(readiness)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue()
    const shutdownSpy = vi.spyOn(AgentBridgeClient.prototype, 'shutdown').mockResolvedValue({ ok: true })

    await expect(manager.ensureReady()).resolves.toEqual(readiness)
    expect(startSpy).not.toHaveBeenCalled()
    expect(checkReadinessSpy).toHaveBeenCalledTimes(1)
    expect(shutdownSpy).not.toHaveBeenCalled()
    expect((manager as any).child).toBeNull()
    expect(manager.getRuntimeState()).toMatchObject({
      ready: false,
      running: false,
      attached: true,
      pid: undefined,
    })

    await manager.stop()

    expect(shutdownSpy).toHaveBeenCalledTimes(1)
  })
})
