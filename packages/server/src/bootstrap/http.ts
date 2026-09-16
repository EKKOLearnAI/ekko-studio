import { setupMobileTerminal } from '../modules/hermes/sockets/mobile-terminal'
import { getSessionMetadata as getTerminalSessionMetadata } from '../modules/studio/public/sessions'
import Koa from 'koa'
import type { Context } from 'koa'
import cors from '@koa/cors'
import serve from 'koa-static'
import send from 'koa-send'
import { relative, resolve } from 'path'
import { mkdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { config, shouldCreateWebUiDataDir } from '../modules/studio/public/config'
import { initLoginLimiter } from '../modules/studio/services/auth/login-limiter'
import { createShutdownHandler } from './lifecycle'
import { setupTerminalWebSocket } from '../modules/hermes/sockets/terminal'
import { setupKanbanEventsWebSocket } from '../modules/hermes/sockets/kanban-events'
import { startVersionCheck } from './health'
import { registerRoutes } from './routes'
import { dshPluginUi } from '../modules/coding-agents/services'
import './chat-agent-runtime-adapter'
import './skill-files-adapter'
import { setGroupChatServer } from '../modules/studio/routes/group-chat'
import { setChatRunServer } from '../modules/studio/public/chat-run'
import { GroupChatServer } from '../modules/studio/public/group-chat'
import {
  getGroupAgentOutboundRelayManager,
  GroupAgentRelayServer,
} from '../modules/studio/services/group-chat/agent-relay'
import { ChatRunSocket } from '../modules/studio/sockets/chat-run'
import { startChatWebhookDispatcher } from '../modules/studio/services/webhooks'
import { getAgentBridgeManager, startAgentBridgeManager } from '../modules/hermes/services/bridge'
import { HermesSkillInjector } from '../modules/hermes/services/skills/injector'
import { injectBundledMcpServer } from '../modules/hermes/services/mcp/studio-autoinject'
import { ensureProfileGatewaysRunning } from '../modules/hermes/services/gateway/autostart'
import { runRegisteredStartupTasks } from './startup-tasks'
import { refreshConfiguredProviderModelCatalogsInBackground } from '../modules/hermes/services/providers/model-catalog-cache'
import { initializeOpenCodeFreeInBackground } from '../modules/hermes/services/providers/opencode-free'
import {
  scanLanDevices,
  selectLanIPv4Address,
  startLanDiscoveryResponder,
  stopLanDiscoveryResponder,
} from './lan-discovery'
import { getLanPeerSocketManager, getLanPeerSocketPath } from './lan-peer'
import { startGlobalAgentServer } from '../modules/studio/public/global-agent'
import { startLocalAppRelayServer } from '../modules/studio/services/app-relay/server'
import {
  hasPendingCloudAppConnectionRevocations,
  listAppConnections,
} from '../modules/studio/repositories/app-connections-store'
import { ensureAppRelayHostClient } from '../modules/studio/services/app-relay/connection'
import { setupGlobalEkkoAgent } from './ekko'
import { injectManagedEkkoMcpServers } from '../modules/ekko/services/mcp'
import { WorkflowSocketServer } from '../modules/studio/sockets/workflow'
import { PetStateSocketServer } from '../modules/studio/sockets/pet-state'
import { logger } from '../modules/studio/public/logging'
import { createStaticCompressionMiddleware } from '../modules/studio/middleware/static-compression'
import { getStaticCacheControl, SPA_ENTRY_CACHE_CONTROL } from '../modules/studio/middleware/static-cache'
import { requireUserJwt, resolveUserProfile } from '../modules/studio/middleware/auth'
import {
  createCorsOriginResolver,
  parseUpgradeRequestUrl,
  securityHeaders,
  writeBadUpgradeRequest,
} from '../modules/studio/middleware/security'
import type { AdditionalShutdownStep, ShutdownHandler } from './lifecycle'
import { createCodexProxyRequestBodyParser, createRequestBodyParser } from '../modules/studio/middleware/request-body-parser'
import {
  getCodingAgentsStatus,
  migratePersistedPiRuntimeMcpConfigs,
  restorePersistedCodexProxyTargets,
  restorePersistedPiProxyTargets,
} from './coding-agents'
import { isAuthorizedCodexProxyRequest } from '../modules/coding-agents/services/codex/proxy'
import {
  configurePreferredHermesRuntime,
  readLockedDesktopHermesSelection,
  type HermesRuntimeSelection,
} from '../modules/hermes/services/runtime/selection'
import {
  getRuntimeVersionStatus,
  readActiveVersionManifest,
} from '../modules/hermes/services/runtime/version-manager'
import { isHermesAgentAvailable, updateAgentStatus } from '../modules/studio/public/agent-status-registry'

// Injected by esbuild at build time; fallback to reading package.json in dev mode
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return 'dev' } })()

let server: any = null
const servers: any[] = []
let groupChatServer: GroupChatServer | null = null
let chatRunServer: any = null
let workflowSocketServer: WorkflowSocketServer | null = null
let petStateSocketServer: PetStateSocketServer | null = null
let groupAgentRelayServer: GroupAgentRelayServer | null = null
let agentBridgeManager: any = null
let desktopShutdownHandler: ShutdownHandler | null = null
let shutdownRequested = false
let bootstrapReady = false
const additionalShutdownSteps: AdditionalShutdownStep[] = []

function getShutdownHandler(): ShutdownHandler {
  shutdownRequested = true
  if (!desktopShutdownHandler) {
    desktopShutdownHandler = createShutdownHandler(
      servers,
      groupChatServer,
      chatRunServer,
      agentBridgeManager,
      additionalShutdownSteps,
    )
  }
  return desktopShutdownHandler
}

async function shutdownAfterFatal(signal: string): Promise<void> {
  try {
    await getShutdownHandler()(signal, 1)
  } catch (shutdownError) {
    logger.fatal(shutdownError, 'Fatal error while cleaning up after %s', signal)
    process.exit(1)
  }
}

// Install signal/error handling before bootstrap starts spawning managed
// process trees. The shutdown handler itself is created lazily so it captures
// every runtime that has been initialized at the point of failure.
process.once('SIGUSR2', signal => { void getShutdownHandler()(signal) })
process.on('SIGINT', signal => { void getShutdownHandler()(signal) })
process.on('SIGTERM', signal => { void getShutdownHandler()(signal) })

process.on('uncaughtException', (err) => {
  console.error('FATAL: Uncaught exception')
  console.error(err)
  logger.fatal(err, 'Uncaught exception')
  void shutdownAfterFatal('uncaught-exception')
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection')
  console.error(reason)
  logger.error(reason, 'Unhandled rejection')
})

interface ListenResult {
  primary: any
  servers: any[]
}

function listen(app: Koa, port: number, host: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host)
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
}

async function listenWithFallback(app: Koa, port: number, host?: string): Promise<ListenResult> {
  const bindHost = host || '0.0.0.0'
  console.log(`[bootstrap] listening on ${bindHost}:${port}`)
  const primary = await listen(app, port, bindHost)
  return { primary, servers: [primary] }
}

function getLoopbackBaseUrl(httpServer: any): string {
  const address = httpServer?.address?.()
  const port = typeof address === 'object' && address?.port ? address.port : config.port
  return `http://127.0.0.1:${port}`
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.')
}

function bearerToken(ctx: Context): string {
  const header = ctx.get('authorization')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function registerDesktopShutdownRoute(app: Koa): void {
  app.use(async (ctx, next) => {
    if (ctx.method !== 'POST' || ctx.path !== '/api/desktop/shutdown') {
      await next()
      return
    }

    if (!isDesktopRuntime()) {
      ctx.status = 404
      ctx.body = { error: 'not_found' }
      return
    }

    const remoteAddress = ctx.req.socket.remoteAddress
    if (!isLoopbackAddress(remoteAddress)) {
      ctx.status = 403
      ctx.body = { error: 'forbidden' }
      return
    }

    const expectedToken = String(process.env.AUTH_TOKEN || '').trim()
    if (!expectedToken || bearerToken(ctx) !== expectedToken) {
      ctx.status = 401
      ctx.body = { error: 'unauthorized' }
      return
    }

    if (!desktopShutdownHandler) {
      ctx.status = 503
      ctx.body = { error: 'shutdown_not_ready' }
      return
    }

    ctx.status = 202
    ctx.body = { ok: true }
    setTimeout(() => {
      void desktopShutdownHandler?.('desktop-api')
    }, 50).unref?.()
  })
}

function registerReadinessRoute(app: Koa): void {
  app.use(async (ctx, next) => {
    if ((ctx.method !== 'GET' && ctx.method !== 'HEAD') || ctx.path !== '/health/ready') {
      await next()
      return
    }
    ctx.status = bootstrapReady ? 200 : 503
    ctx.body = { status: bootstrapReady ? 'ready' : 'starting' }
  })
}

async function ensureStartupDirectory(directory: string, label: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    logger.warn(error, '[bootstrap] failed to prepare %s directory; affected operations will report their own errors', label)
  }
}

function envFlagEnabled(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function gatewayAutostartDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
}

function skillInjectionDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
}

async function startRuntimeServicesBeforeListen(hermesAvailable: boolean): Promise<void> {
  if (!hermesAvailable) {
    console.log('[bootstrap] Hermes Agent unavailable; skipping profile gateways and agent bridge')
    return
  }
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    try {
      await ensureProfileGatewaysRunning()
      console.log('[bootstrap] profile gateways checked')
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to ensure profile gateways')
      console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
    }
  }

  if (shutdownRequested) return
  try {
    agentBridgeManager = await startAgentBridgeManager()
    console.log('[bootstrap] agent bridge started')
  } catch (err) {
    logger.warn(err, '[bootstrap] agent bridge failed to start')
    console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
  }
}

async function startRuntimeServicesAfterListen(hermesAvailable: boolean): Promise<void> {
  if (!hermesAvailable) {
    console.log('[bootstrap] Hermes Agent unavailable; skipping profile gateways and agent bridge')
    return
  }
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    try {
      await ensureProfileGatewaysRunning()
      console.log('[bootstrap] profile gateways checked')
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to ensure profile gateways')
      console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
    }
  }

  if (shutdownRequested) return
  try {
    agentBridgeManager = await startAgentBridgeManager()
    console.log('[bootstrap] agent bridge started')
  } catch (err) {
    logger.warn(err, '[bootstrap] agent bridge failed to start')
    console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
  }
}

function startLanDiscovery(): void {
  const discoverySocket = startLanDiscoveryResponder({ httpPort: config.port })
  let initialScanStarted = false
  const runInitialScan = () => {
    if (initialScanStarted) return
    initialScanStarted = true
    void scanLanDevices().catch(err => logger.warn(err, '[lan-discovery] initial scan failed'))
  }

  if (discoverySocket) {
    discoverySocket.once('listening', runInitialScan)
    const fallbackTimer = setTimeout(runInitialScan, 500)
    fallbackTimer.unref?.()
  } else {
    runInitialScan()
  }
}

function recordLockedHermesSelection(selection: HermesRuntimeSelection): void {
  if (selection.source === 'none' || !selection.path) {
    const activationError = readActiveVersionManifest()?.runtimeActivationError || ''
    updateAgentStatus('hermes', {
      name: 'Hermes',
      provider: 'Nous Research',
      kind: 'hermes',
      installed: false,
      version: '',
      source: 'not-installed',
      path: '',
      error: activationError,
      installations: [],
    })
    return
  }

  updateAgentStatus('hermes', {
    name: 'Hermes',
    provider: 'Nous Research',
    kind: 'hermes',
    installed: true,
    version: selection.version,
    source: selection.source,
    path: selection.path,
    error: '',
    installations: [{
      path: selection.path,
      version: selection.version,
      source: selection.source,
      selected: true,
      ...(selection.managedRuntimeVersion
        ? { managedRuntimeVersion: selection.managedRuntimeVersion }
        : {}),
    }],
  })
}

export async function bootstrap() {
  bootstrapReady = false
  console.log(`hermes-web-ui v${APP_VERSION} starting...`)
  try {
    await runRegisteredStartupTasks()
  } catch {
    logger.warn('[bootstrap] startup task state could not be read or saved; deferred remaining tasks')
  }
  await ensureStartupDirectory(config.uploadDir, 'upload')
  if (shouldCreateWebUiDataDir()) {
    await ensureStartupDirectory(config.dataDir, 'development data')
  }

  const lockedDesktopSelection = readLockedDesktopHermesSelection()
  let hermesSelection: HermesRuntimeSelection = lockedDesktopSelection
    || { source: 'none', version: '', path: '' }
  if (!lockedDesktopSelection) {
    try {
      hermesSelection = await configurePreferredHermesRuntime()
    } catch (error) {
      logger.warn(error, '[bootstrap] failed to inspect Hermes Runtime; continuing without a selected runtime')
    }
  }
  console.log(`[bootstrap] Hermes source=${hermesSelection.source} version=${hermesSelection.version || '-'} path=${hermesSelection.path || '-'} python=${hermesSelection.pythonPath || '-'} root=${hermesSelection.agentRoot || '-'}`)
  if (lockedDesktopSelection) recordLockedHermesSelection(hermesSelection)
  updateAgentStatus('ekko-agent', { version: APP_VERSION })
  const inventoryResults = await Promise.allSettled([
    ...(!lockedDesktopSelection ? [getRuntimeVersionStatus({ includeRemote: false })] : []),
    getCodingAgentsStatus(),
  ])
  for (const result of inventoryResults) {
    if (result.status === 'rejected') {
      logger.warn(result.reason, '[bootstrap] failed to initialize an Agent status source')
    }
  }
  const hermesAgentAvailable = isHermesAgentAvailable()
  console.log(`[bootstrap] Hermes Agent inventory status=${hermesAgentAvailable ? 'available' : 'not-installed'}`)
  await initLoginLimiter()
  if (skillInjectionDisabled()) {
    console.log('[bootstrap] bundled skill injection disabled by HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
  } else {
    try {
      const skillInjector = new HermesSkillInjector()
      const injectionResult = await skillInjector.injectMissingSkills()
      if (injectionResult.injected.length > 0) {
        logger.info({
          injected: [...new Set(injectionResult.injected)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills injected')
      }
      if (injectionResult.updated.length > 0) {
        logger.info({
          updated: [...new Set(injectionResult.updated)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills updated')
      }
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to inject bundled skills')
      console.warn('[bootstrap] failed to inject bundled skills:', err instanceof Error ? err.message : err)
    }
  }

  try {
    await injectBundledMcpServer()
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to inject bundled MCP server')
    console.warn('[bootstrap] failed to inject bundled MCP server:', err instanceof Error ? err.message : err)
  }

  try {
    const migratedPiMcpConfigs = await migratePersistedPiRuntimeMcpConfigs()
    if (migratedPiMcpConfigs > 0) {
      console.log(`[bootstrap] migrated ${migratedPiMcpConfigs} persisted Pi MCP runtime config(s) to proxy mode`)
    }
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to migrate persisted Pi MCP runtime configs')
  }

  try {
    const restoredCodexProxyTargets = await restorePersistedCodexProxyTargets()
    if (restoredCodexProxyTargets > 0) {
      console.log(`[bootstrap] restored ${restoredCodexProxyTargets} persisted Codex/Grok proxy target(s)`)
    }
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to restore persisted Codex/Grok proxy targets')
  }

  try {
    const restoredPiProxyTargets = await restorePersistedPiProxyTargets()
    if (restoredPiProxyTargets > 0) {
      console.log(`[bootstrap] restored ${restoredPiProxyTargets} persisted Pi proxy target(s)`)
    }
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to restore persisted Pi proxy targets')
  }

  try {
    const ekkoSetup = setupGlobalEkkoAgent()
    try {
      const injection = injectManagedEkkoMcpServers(ekkoSetup)
      const changed = injection.targets.filter(target => target.status === 'injected' || target.status === 'updated')
      if (changed.length > 0) {
        logger.info({
          serverNames: injection.serverNames,
          targets: changed,
        }, '[bootstrap] Studio MCP servers injected into Ekko config')
      }
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to inject Studio MCP servers into Ekko config')
      console.warn('[bootstrap] failed to inject Studio MCP servers into Ekko config:', err instanceof Error ? err.message : err)
    }
    console.log('[bootstrap] ekko-agent setup complete')
  } catch (err) {
    logger.error(err, '[bootstrap] ekko-agent setup failed; continuing with Ekko unavailable')
    console.error('[bootstrap] ekko-agent setup failed; continuing without Ekko:', err instanceof Error ? err.message : err)
  }

  agentBridgeManager = getAgentBridgeManager()
  if (!isDesktopRuntime()) {
    await startRuntimeServicesBeforeListen(hermesAgentAvailable)
  }
  if (shutdownRequested) return

  const app = new Koa()
  // Initialize all web-ui SQLite tables
  const { initAllStores } = await import('../modules/studio/infrastructure/database/init')
  initAllStores()
  const { interruptOrphanedTaskPlans } = await import('../modules/studio/repositories/task-plan-store')
  interruptOrphanedTaskPlans()
  startChatWebhookDispatcher()
  console.log('[bootstrap] all stores initialized')

  app.use(securityHeaders())
  app.use(cors({ origin: createCorsOriginResolver(config.corsOrigins) }))
  // Codex can replay inline images from its native thread. Accept a bounded,
  // authenticated request here so the proxy can remove historical image data
  // before dispatching to any provider API mode.
  app.use(createCodexProxyRequestBodyParser(isAuthorizedCodexProxyRequest))
  app.use(dshPluginUi.middleware)
  // Raise body limits above the default 1mb: profile avatars and MiMo voice-clone
  // reference audio are posted as base64 data URLs before reaching handlers.
  app.use(createRequestBodyParser())
  console.log('[bootstrap] cors + bodyParser registered')

  registerReadinessRoute(app)
  registerDesktopShutdownRoute(app)

  // Register all routes (handles auth internally)
  registerRoutes(app, [requireUserJwt, resolveUserProfile])
  console.log('[bootstrap] routes registered')

  // SPA fallback
  const distDir = resolve(__dirname, '..', 'client')
  app.use(createStaticCompressionMiddleware())
  app.use(serve(distDir, {
    setHeaders(res, filePath) {
      const cacheControl = getStaticCacheControl(relative(distDir, filePath))
      if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    },
  }))
  app.use(async (ctx) => {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') &&
      !ctx.path.startsWith('/api') &&
      ctx.path !== '/health') {
      ctx.set('Cache-Control', SPA_ENTRY_CACHE_CONTROL)
      await send(ctx, 'index.html', { root: distDir })
    }
  })
  console.log('[bootstrap] SPA fallback registered')

  // Start server using the configured bind host. Default is IPv4 for WSL stability.
  const listenResult = await listenWithFallback(app, config.port, config.host)
  server = listenResult.primary
  servers.splice(0, servers.length, ...listenResult.servers)
  console.log('[bootstrap] app.listen called')
  // The Desktop shell only needs registered HTTP routes and static assets before
  // it can render. Keep slower runtime, socket, and recovery work below in the
  // background startup path, matching the pre-readiness launch behavior.
  bootstrapReady = true
  console.log('[bootstrap] web UI shell ready')

  const closeDshPluginUi = dshPluginUi.attach(servers)
  additionalShutdownSteps.push({ name: 'DSH plugin UI transport', close: closeDshPluginUi })
  const terminalWebSocket = setupTerminalWebSocket(servers)
  if (terminalWebSocket) {
    additionalShutdownSteps.push({
      name: 'Terminal WebSocket and PTY sessions',
      close: () => terminalWebSocket.close(),
      forceClose: () => terminalWebSocket.forceClose(),
    })
  }
  const kanbanEventsWebSocket = setupKanbanEventsWebSocket(servers)
  additionalShutdownSteps.push({
    name: 'Kanban event WebSocket and watchers',
    close: () => kanbanEventsWebSocket.close(),
    forceClose: () => kanbanEventsWebSocket.forceClose(),
  })
  const lanPeerSocketManager = getLanPeerSocketManager()
  lanPeerSocketManager.setupServer(servers)
  additionalShutdownSteps.push({
    name: 'LAN peer WebSocket and child runtimes',
    close: () => lanPeerSocketManager.shutdown(),
    forceClose: () => lanPeerSocketManager.forceClose(),
  })
  console.log('[bootstrap] terminal + kanban + LAN peer websocket setup')

  const loopbackBaseUrl = getLoopbackBaseUrl(server)

  // Group chat Socket.IO (must be after server is created)
  const activeGroupChatServer = new GroupChatServer(servers)
  groupChatServer = activeGroupChatServer
  setGroupChatServer(activeGroupChatServer)
  groupAgentRelayServer = new GroupAgentRelayServer(activeGroupChatServer.getIO(), activeGroupChatServer)
  additionalShutdownSteps.push({
    name: 'Group agent relay',
    close: () => groupAgentRelayServer?.shutdown(),
  })

  // Chat run Socket.IO — shares the same Server instance, just adds /chat-run namespace
  chatRunServer = new ChatRunSocket(activeGroupChatServer.getIO())
  setChatRunServer(chatRunServer)
  activeGroupChatServer.setChatRunService(chatRunServer)
  chatRunServer.init()
  const mobileTerminal = setupMobileTerminal(activeGroupChatServer.getIO(), context => {
    if (context.source === 'single') {
      const session = getTerminalSessionMetadata(context.sourceId)
      return session ? { profile: session.profile, workspace: session.workspace || '' } : null
    }
    const room = activeGroupChatServer.getStorage().getRoom(context.sourceId)
    return room ? { profile: context.profile, workspace: room.workspace || '' } : null
  })
  additionalShutdownSteps.push({ name: 'Mobile terminal PTY sessions', close: () => mobileTerminal.close() })
  startLocalAppRelayServer(activeGroupChatServer.getIO(), { localBaseUrl: loopbackBaseUrl })
  console.log('[bootstrap] local App relay server ready')
  if (
    listAppConnections().some(connection => connection.connection_type === 'cloud')
    || hasPendingCloudAppConnectionRevocations()
  ) {
    void ensureAppRelayHostClient().catch(err => logger.warn(err, '[app-relay] cloud host restore failed'))
  }
  const groupAgentOutboundRelayManager = getGroupAgentOutboundRelayManager(
    () => activeGroupChatServer.getChatRunService(),
  )
  additionalShutdownSteps.push({
    name: 'Group agent outbound relay',
    close: () => groupAgentOutboundRelayManager.shutdown(),
  })
  void groupAgentOutboundRelayManager.restore()

  // A process restart loses in-memory scheduler, approval, and runner ownership.
  // Persist a fail-closed terminal state before exposing workflow sockets, then abort
  // any surviving session runners through the now-registered ChatRun service.
  const { getWorkflowManager } = await import('../modules/studio/services/workflow/manager')
  const recoveredWorkflows = await getWorkflowManager().recoverActiveRuns()
  if (recoveredWorkflows.runs > 0) {
    logger.warn('Recovered %d orphaned workflow runs and aborted %d sessions', recoveredWorkflows.runs, recoveredWorkflows.sessions)
  }
  const { getWorkflowScheduleService } = await import('../modules/studio/services/workflow/schedule')
  const workflowScheduleService = getWorkflowScheduleService()
  workflowScheduleService.start()
  additionalShutdownSteps.push({
    name: 'Workflow scheduler',
    close: () => workflowScheduleService.stop(),
  })

  workflowSocketServer = new WorkflowSocketServer(activeGroupChatServer.getIO())
  workflowSocketServer.init()
  additionalShutdownSteps.push({
    name: 'Workflow Socket.IO runtime',
    close: () => workflowSocketServer?.close(),
  })

  petStateSocketServer = new PetStateSocketServer(activeGroupChatServer.getIO())
  petStateSocketServer.init()

  startGlobalAgentServer(activeGroupChatServer.getIO(), { localBaseUrl: loopbackBaseUrl })
  console.log('[bootstrap] global agent server ready')

  // Session deleter — periodically drain pending session deletes
  const { SessionDeleter } = await import('../modules/hermes/services/history/session-deleter')
  const sessionDeleter = SessionDeleter.getInstance()
  const activeProfile = process.env.PROFILE || 'default'
  sessionDeleter.start(activeProfile)
  additionalShutdownSteps.push({
    name: 'Session deleter',
    close: () => sessionDeleter.stop(),
  })
  console.log('[bootstrap] session deleter started, profile=%s', activeProfile)

  // Catch-all: destroy upgrade requests not handled by terminal or Socket.IO
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', (req: any, socket: any) => {
      const url = parseUpgradeRequestUrl(req)
      if (!url) {
        writeBadUpgradeRequest(socket)
        return
      }
      if (!dshPluginUi.handlesUpgrade(req) &&
        url.pathname !== '/api/hermes/terminal' &&
        url.pathname !== '/api/hermes/kanban/events' &&
        url.pathname !== getLanPeerSocketPath() &&
        !url.pathname.startsWith('/socket.io/')) {
        socket.destroy()
      }
    })
  })

  const selectedLanAddress = selectLanIPv4Address('')
  const localIp = selectedLanAddress === '127.0.0.1' ? 'localhost' : selectedLanAddress
  console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
  console.log(`Log: ${config.appHome}/logs/server.log`)
  logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)
  startLanDiscovery()
  additionalShutdownSteps.push({
    name: 'LAN discovery responder',
    close: stopLanDiscoveryResponder,
  })
  refreshConfiguredProviderModelCatalogsInBackground('bootstrap')
  initializeOpenCodeFreeInBackground()

  if (isDesktopRuntime()) {
    await startRuntimeServicesAfterListen(hermesAgentAvailable)
  }
  if (shutdownRequested) return

  // Restore group chat agents after server is ready.
  activeGroupChatServer.restoreWhenReady()

  servers.forEach((httpServer) => {
    httpServer.on('error', (err: any) => {
      console.error('[bootstrap] server error:', err.code || err.message)
      logger.error({ err }, 'Server error')
    })
  })

  desktopShutdownHandler = createShutdownHandler(
    servers,
    activeGroupChatServer,
    chatRunServer,
    agentBridgeManager,
    additionalShutdownSteps,
  )
  startVersionCheck()
  console.log('[bootstrap] startup complete')
}

bootstrap().catch((error) => {
  console.error('FATAL: Failed to start Hermes Web UI')
  console.error(error)
  logger.fatal(error, 'Fatal error during bootstrap')
  void shutdownAfterFatal('bootstrap-error')
})
