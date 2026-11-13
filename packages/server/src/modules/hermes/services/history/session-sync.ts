/**
 * Hermes session import is intentionally disabled.
 *
 * Hermes state.db remains a read-only source for Hermes-specific history APIs.
 * The web-ui local sessions/messages tables must not be populated from Hermes
 * on startup, because that can mix ownership and make data-loss incidents much
 * harder to reason about.
 */
import { logger } from '../../../studio/public/logging'

export async function syncAllHermesSessionsOnStartup(): Promise<void> {
  logger.info('[session-sync] Hermes session import is disabled')
}
