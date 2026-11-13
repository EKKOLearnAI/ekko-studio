/**
 * Preflight failure → HTTP response semantics for the phase (a) update
 * system (master spec § Preflight → HTTP Status).
 *
 * Settled contract:
 *   - Recoverable failures (disk space, manifest fetch) return 503 with
 *     `retry_after_seconds` so the UI can tell the user when to retry
 *     instead of offering a retry that cannot succeed.
 *   - Structural failures (permissions, node range, invalid manifest,
 *     stale installer, ship block, invalid policy) return 409 and are
 *     NOT retryable — they need operator intervention.
 *   - `update_journal_corrupt` is logged server-side only; the handler
 *     maps it to a non-retryable 500 without API surfacing beyond that.
 */

import { UpdateError, type UpdateErrorCode } from './errors'

export type PreflightFailureKind = 'recoverable' | 'structural' | 'internal'

interface PreflightFailureShape {
  kind: PreflightFailureKind
  status: number
  retryAfterSeconds: number | null
}

const RECOVERABLE: Partial<Record<UpdateErrorCode, { status: number; retryAfterSeconds: number }>> = {
  update_preflight_space: { status: 503, retryAfterSeconds: 3600 },
  update_manifest_fetch_failed: { status: 503, retryAfterSeconds: 60 },
}

const STRUCTURAL: Partial<Record<UpdateErrorCode, { status: number }>> = {
  update_preflight_permissions: { status: 409 },
  update_incompatible_node: { status: 409 },
  update_incompatible_current_version: { status: 409 },
  update_manifest_invalid: { status: 409 },
  update_installer_script_missing: { status: 409 },
  update_installer_script_stale: { status: 409 },
  update_ship_block: { status: 409 },
  update_policy_invalid: { status: 409 },
  update_data_preservation_unavailable: { status: 409 },
}

export function preflightFailureShape(err: unknown): PreflightFailureShape | null {
  if (!(err instanceof UpdateError)) return null
  const recoverable = RECOVERABLE[err.code]
  if (recoverable) {
    return { kind: 'recoverable', status: recoverable.status, retryAfterSeconds: recoverable.retryAfterSeconds }
  }
  const structural = STRUCTURAL[err.code]
  if (structural) {
    return { kind: 'structural', status: structural.status, retryAfterSeconds: null }
  }
  return { kind: 'internal', status: err.status || 500, retryAfterSeconds: null }
}

/**
 * Apply the settled preflight semantics to a Koa context in the update
 * controller's catch block. Returns true when the error followed the
 * recoverable/structural mapping (and `retry_after_seconds` was added).
 */
export function applyPreflightFailureResponse(err: unknown, ctx: { status: number; body: unknown }): boolean {
  const shape = preflightFailureShape(err)
  if (!shape || shape.kind === 'internal') return false
  ctx.status = shape.status
  if (shape.kind === 'recoverable' && ctx.body && typeof ctx.body === 'object') {
    (ctx.body as Record<string, unknown>).retry_after_seconds = shape.retryAfterSeconds
  }
  return true
}
