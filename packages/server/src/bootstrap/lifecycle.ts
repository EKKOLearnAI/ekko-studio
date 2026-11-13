import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'
import { shutdownDshManagement } from '../modules/coding-agents/services/dsh/management'
import { shutdownDshPluginOperations } from '../modules/coding-agents/services/dsh/plugins'
import { forceStopManagedGateways, shutdownManagedGateways } from '../modules/hermes/services/gateway/runner'
import { closeDb } from '../modules/studio/infrastructure/database'
import { logger } from '../modules/studio/public/logging'
import { shutdownLocalSttRuntime } from '../modules/studio/services/voice/stt/local-model-manager'
import { stopOutboundRelayClient } from '../modules/studio/public/global-agent'
import { stopAppRelayClient } from '../modules/studio/services/app-relay/client'
import { closeGlobalEkkoAgent } from '../modules/ekko/services/manager'
import { stopChatWebhookDispatcher } from '../modules/studio/services/webhooks'
import { shutdownSocialMessageRuntimes } from '../modules/studio/services/social-messages'
import { stopPreviewRuntime } from './update'

const DEFAULT_SHUTDOWN_FORCE_EXIT_MS = 10_000
const DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS = 10_000

function envPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function getShutdownForceExitMs(): number {
  const override = envPositiveInt('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS')
  if (override) return override
  const desktop = String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
  return desktop ? DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS : DEFAULT_SHUTDOWN_FORCE_EXIT_MS
}

export function shouldStopAgentBridgeOnShutdown(_signal: string): boolean {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  // Restart now defaults to a fresh bridge so package/runtime upgrades do not
  // attach to stale brokers. Operators can opt back into restart resume with
  // HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0.
  return true
}

export function shouldStopManagedGatewaysOnShutdown(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  // Only gateways spawned through the managed runner are present in its
  // ownership registry, so stopping by default cannot touch an externally
  // managed gateway that Studio merely discovered.
  return true
}

export interface AdditionalShutdownStep {
  name: string
  close: () => void | Promise<void>
  forceClose?: () => void
}

export type ShutdownHandler = (signal: string, exitCode?: number) => Promise<void>

async function runShutdownStep(name: string, step: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now()
  try {
    await step()
    logger.info({ durationMs: Date.now() - startedAt }, '%s stopped', name)
  } catch (err) {
    logger.warn({ err, durationMs: Date.now() - startedAt }, 'Failed to stop %s (non-fatal)', name)
  }
}

export function createShutdownHandler(
  server: any,
  groupChatServer?: any,
  chatRunServer?: any,
  agentBridgeManager?: any,
  additionalSteps: AdditionalShutdownStep[] = [],
): ShutdownHandler {
  let shutdownPromise: Promise<void> | null = null

  return (signal: string, exitCode = 0) => {
    if (shutdownPromise) return shutdownPromise

    const stopAgentBridge = Boolean(agentBridgeManager && shouldStopAgentBridgeOnShutdown(signal))
    const stopManagedGateways = shouldStopManagedGatewaysOnShutdown()
    const shutdownStartedAt = Date.now()

    shutdownPromise = (async () => {
      // Give resource cleanup a short bounded window, then prefer a clean
      // process tree over waiting indefinitely for graceful acknowledgements.
      const forceExitTimer = setTimeout(() => {
        logger.warn(
          { elapsedMs: Date.now() - shutdownStartedAt },
          'Graceful shutdown deadline reached; force-stopping owned process trees',
        )
        if (stopManagedGateways) {
          try {
            forceStopManagedGateways()
          } catch (err) {
            logger.warn(err, 'Failed to force-stop managed gateways during shutdown timeout')
          }
        }
        for (const step of additionalSteps) {
          try { step.forceClose?.() } catch (err) {
            logger.warn(err, 'Failed to force-stop %s during shutdown timeout', step.name)
          }
        }
        if (stopAgentBridge) {
          try {
            agentBridgeManager?.forceStop?.()
          } catch (err) {
            logger.warn(err, 'Failed to force-stop agent bridge during shutdown timeout')
          }
        }
        try {
          void shutdownDshPluginOperations()
          codingAgentRunManager.shutdown()
        } catch (err) {
          logger.warn(err, 'Failed to force-stop coding agent processes during shutdown timeout')
        }
        process.exit(exitCode)
      }, getShutdownForceExitMs())

      logger.info('Shutting down (%s)...', signal)
      console.log(`[shutdown] Received signal: ${signal}`)

      try {
        // Managed gateways are bounded child-process trees. Stop them first so
        // a later cleanup hang cannot strand them after the force-exit deadline.
        if (stopManagedGateways) {
          await runShutdownStep('Managed gateways', async () => {
            const result = await shutdownManagedGateways()
            logger.info('[shutdown] managed gateways stopped result=%j', result)
          })
        } else {
          logger.info('[shutdown] leaving managed gateways running')
        }

        await runShutdownStep('Preview runtime', stopPreviewRuntime)
        await runShutdownStep('DSH plugin operations', shutdownDshPluginOperations)
        await runShutdownStep('DSH management host', shutdownDshManagement)
        await runShutdownStep('Local STT runtime', shutdownLocalSttRuntime)
        await runShutdownStep('Social message runtimes', shutdownSocialMessageRuntimes)

        // Stop accepting/routing chat work before stopping the bridge. This
        // lets ChatRunSocket release claimed background completions while the
        // broker is still reachable.
        if (chatRunServer) await runShutdownStep('ChatRunSocket', () => chatRunServer.close())
        await runShutdownStep('Chat webhook dispatcher', () => stopChatWebhookDispatcher())

        // These runtimes own the most likely long-lived descendants (PTYs,
        // watchers, exec jobs, and coding agents), so begin their teardown
        // before waiting on relays and network servers.
        await runShutdownStep('Coding agent hidden sessions', () => codingAgentRunManager.shutdown())

        for (const step of additionalSteps) {
          await runShutdownStep(step.name, step.close)
        }

        if (stopAgentBridge) {
          if (process.platform === 'win32' && typeof agentBridgeManager.forceStop === 'function') {
            await runShutdownStep('Agent bridge process tree', () => agentBridgeManager.forceStop())
          } else {
            await runShutdownStep('Agent bridge', () => agentBridgeManager.stop())
          }
        } else if (agentBridgeManager) {
          logger.info('Leaving agent bridge running across Web UI shutdown')
        }

        await runShutdownStep('Outbound relay clients', () => stopOutboundRelayClient())
        await runShutdownStep('App relay clients', () => stopAppRelayClient())

        // Disconnect Socket.IO before HTTP server to prevent hanging, and wait
        // for adapter/namespace cleanup instead of racing process.exit().
        if (groupChatServer) {
          await runShutdownStep('Group chat agents', () => groupChatServer.agentClients.disconnectAll())
          await runShutdownStep('Socket.IO', () => groupChatServer.getIO().close())
        }

        const servers = Array.isArray(server) ? server : [server].filter(Boolean)
        if (servers.length) {
          await runShutdownStep('HTTP servers', () => Promise.all(servers.map((httpServer) => (
            new Promise<void>((resolve) => {
              if (httpServer.listening === false) {
                resolve()
                return
              }
              httpServer.close(() => resolve())
            })
          ))).then(() => undefined))
        }
      } finally {
        await runShutdownStep('Global Ekko agent', () => closeGlobalEkkoAgent())
        await runShutdownStep('Database', () => closeDb())
        clearTimeout(forceExitTimer)
        logger.info({ durationMs: Date.now() - shutdownStartedAt }, 'Shutdown cleanup complete')
        process.exit(exitCode)
      }
    })()

    return shutdownPromise
  }
}

export function bindShutdown(
  server: any,
  groupChatServer?: any,
  chatRunServer?: any,
  agentBridgeManager?: any,
  additionalSteps: AdditionalShutdownStep[] = [],
): ShutdownHandler {
  const shutdown = createShutdownHandler(server, groupChatServer, chatRunServer, agentBridgeManager, additionalSteps)

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return shutdown
}
