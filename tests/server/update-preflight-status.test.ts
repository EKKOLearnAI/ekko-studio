/**
 * Tests for phase (a) preflight failure HTTP semantics.
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Preflight →
 * HTTP Status). Recoverable → 503 + retry_after_seconds; structural →
 * 409 not retryable.
 */
import { describe, expect, it } from 'vitest'
import { UpdateError } from '../../packages/server/src/modules/studio/services/update/errors'
import { applyPreflightFailureResponse, preflightFailureShape } from '../../packages/server/src/modules/studio/services/update/preflight-error-response'

function ctx() {
  return { status: 500, body: { success: false, message: 'x' } as Record<string, unknown> }
}

describe('preflightFailureShape', () => {
  it('maps recoverable codes to 503 + retry_after_seconds', () => {
    expect(preflightFailureShape(new UpdateError('update_preflight_space', 'no space')))
      .toEqual({ kind: 'recoverable', status: 503, retryAfterSeconds: 3600 })
    expect(preflightFailureShape(new UpdateError('update_manifest_fetch_failed', 'offline')))
      .toEqual({ kind: 'recoverable', status: 503, retryAfterSeconds: 60 })
  })

  it('maps structural codes to 409 with no retry hint', () => {
    const structural = [
      'update_preflight_permissions',
      'update_incompatible_node',
      'update_incompatible_current_version',
      'update_manifest_invalid',
      'update_installer_script_missing',
      'update_installer_script_stale',
      'update_ship_block',
      'update_policy_invalid',
    ] as const
    for (const code of structural) {
      const shape = preflightFailureShape(new UpdateError(code, 'detail'))
      expect(shape, code).toEqual({ kind: 'structural', status: 409, retryAfterSeconds: null })
    }
  })

  it('maps unknown update codes to internal (no contract override)', () => {
    expect(preflightFailureShape(new UpdateError('update_download_failed', 'x')))
      .toEqual({ kind: 'internal', status: 500, retryAfterSeconds: null })
    expect(preflightFailureShape(new Error('plain'))).toBeNull()
  })
})

describe('applyPreflightFailureResponse', () => {
  it('rewrites recoverable failures to 503 and adds retry_after_seconds', () => {
    const c = ctx()
    const applied = applyPreflightFailureResponse(
      new UpdateError('update_preflight_space', 'insufficient disk space', 409),
      c,
    )
    expect(applied).toBe(true)
    expect(c.status).toBe(503)
    expect(c.body.retry_after_seconds).toBe(3600)
    expect(c.body.success).toBe(false)
  })

  it('rewrites structural failures to 409 without retry hint', () => {
    const c = ctx()
    const applied = applyPreflightFailureResponse(
      new UpdateError('update_ship_block', 'manifest version mismatch'),
      c,
    )
    expect(applied).toBe(true)
    expect(c.status).toBe(409)
    expect(c.body.retry_after_seconds).toBeUndefined()
  })

  it('leaves unmapped errors untouched', () => {
    const c = ctx()
    expect(applyPreflightFailureResponse(new Error('boom'), c)).toBe(false)
    expect(c.status).toBe(500)
  })
})
