/**
 * Shared types for the server-hosted browser runtime
 * (`docs/web-agent-browser/spec-02` and its consumers, spec-03..spec-08).
 */

import type { Readable, Writable } from 'stream'

/** Where a resolved browser executable came from. */
export type BrowserExecutableSource = 'env' | 'bundle' | 'system'

export interface ResolvedBrowserExecutable {
  /** Absolute path to the launcher/executable actually spawned. */
  path: string
  source: BrowserExecutableSource
  /** Version reported by `--version`, when the validation ran. */
  version: string | null
  /**
   * True when `path` is a wrapper script (e.g. the Debian/Ubuntu
   * `/usr/bin/chromium` launcher) rather than the real binary. The launcher is
   * what we spawn — it fills in the runtime environment — but version probing
   * must go through it as well, so this is informational.
   */
  launcher: boolean
}

/** One attempted candidate, kept for error messages and diagnostics. */
export interface BrowserExecutableCandidate {
  path: string
  source: BrowserExecutableSource
  exists: boolean
  ok: boolean
  detail: string
}

/**
 * CDP transport handed to spec-03. `write` is the parent→browser side
 * (child stdio fd 3), `read` is the browser→parent side (fd 4).
 */
export interface BrowserCdpStreams {
  write: Writable
  read: Readable
}

export type HeadlessRuntimeState = 'idle' | 'starting' | 'ready' | 'stopped' | 'failed'

export interface BrowserWindowSize {
  width: number
  height: number
}

export interface HeadlessRuntimeOptions {
  /** Profile id under `<getWebUiHome()>/web-browser/profiles/<id>`. */
  profileId: string
  /** Explicit user-data-dir override (tests). */
  userDataDir?: string
  windowSize: BrowserWindowSize
  /** Hard cap on bringing the process up. Default 15s. */
  startupTimeoutMs: number
  /** How long the process must stay alive to count as started. Default 250ms. */
  readyDelayMs: number
  /** Graceful-exit budget before SIGKILL. Default 5s. */
  stopTimeoutMs: number
}
