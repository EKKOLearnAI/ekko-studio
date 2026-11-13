/**
 * Process-wide Web Broker wiring (spec-05 "Modify: 服务端启动/关闭流程").
 *
 * The broker itself is cheap (one loopback listening socket, no browser
 * process); the browser only starts when the first tab is created. When the
 * surface gate is off nothing is created here at all.
 */

import { logger } from '../../public/logging'
import { isBrowserSurfaceEnabled } from '../../public/browser-surface'
import { WebBrowserBroker, type WebBrowserBrokerOptions } from './broker-server'
import { WebBrowserService } from './web-browser-service'

let broker: WebBrowserBroker | null = null
let service: WebBrowserService | null = null
let starting: Promise<WebBrowserBroker | null> | null = null

export function getWebBrowserService(): WebBrowserService | null {
  return service
}

export function getWebBrowserBroker(): WebBrowserBroker | null {
  return broker
}

export interface StartBrokerOptions extends Partial<Omit<WebBrowserBrokerOptions, 'service'>> {
  enabled?: boolean
}

/**
 * Start the broker (idempotent). Returns `null` when the surface is off, which
 * is the normal state on the desktop (Electron owns the descriptor there).
 */
export async function startWebBrowserBroker(
  options: StartBrokerOptions = {},
): Promise<WebBrowserBroker | null> {
  if (broker) return broker
  if (starting) return starting

  const enabled = options.enabled ?? isBrowserSurfaceEnabled()
  if (!enabled) {
    logger.info('[browser-broker] browser surface is off; broker not started')
    return null
  }

  starting = (async () => {
    try {
      const activeService = service ?? new WebBrowserService()
      service = activeService
      const instance = new WebBrowserBroker({ ...options, service: activeService })
      const descriptor = await instance.start()
      broker = instance
      logger.info(
        '[browser-broker] listening on %s (descriptor write: %s)',
        descriptor.endpoint,
        instance.descriptorWrite,
      )
      return instance
    } catch (err) {
      logger.error(err, '[browser-broker] failed to start; the browser panel will be unavailable')
      broker = null
      return null
    } finally {
      starting = null
    }
  })()

  return starting
}

/** Stop the broker and drop the session it owns. Safe to call twice. */
export async function stopWebBrowserBroker(): Promise<void> {
  const instance = broker
  const activeService = service
  broker = null
  service = null
  if (instance) {
    await instance.stop().catch(err => logger.warn(err, '[browser-broker] stop failed (non-fatal)'))
  }
  if (activeService) {
    await activeService.dispose().catch(err => logger.warn(err, '[browser-broker] session dispose failed (non-fatal)'))
  }
}

/** Test hook. */
export function resetWebBrowserBrokerForTests(): void {
  broker = null
  service = null
  starting = null
}
