/**
 * Seam between the process layer (spec-02) and the protocol/session layer
 * (spec-03): this is the only place that knows both. `CdpClient` and
 * `BrowserSession` themselves only depend on the two pipe streams / a minimal
 * CDP interface, which is what keeps them unit-testable without Chrome.
 */

import { CdpClient, type CdpClientOptions } from './cdp-client'
import type { HeadlessRuntime } from './runtime'
import { BrowserSession } from './session'

export interface ConnectBrowserSessionOptions {
  runtime: HeadlessRuntime
  sessionKey: string
  maxTabs?: number
  idleTtlMs?: number
  commandTimeoutMs?: number
}

export interface ConnectedBrowserSession {
  session: BrowserSession
  client: CdpClient
  /** Dispose the session then the client; safe to call twice. */
  close: () => Promise<void>
}

export async function connectBrowserSession(
  options: ConnectBrowserSessionOptions,
): Promise<ConnectedBrowserSession> {
  const streams = await options.runtime.start()
  const clientOptions: CdpClientOptions = { streams }
  if (options.commandTimeoutMs) clientOptions.commandTimeoutMs = options.commandTimeoutMs
  const client = new CdpClient(clientOptions)

  try {
    const session = await BrowserSession.create({
      cdp: client,
      sessionKey: options.sessionKey,
      maxTabs: options.maxTabs,
      idleTtlMs: options.idleTtlMs,
    })
    return {
      session,
      client,
      close: async () => {
        await session.dispose()
        client.dispose()
      },
    }
  } catch (err) {
    client.dispose()
    throw err
  }
}
