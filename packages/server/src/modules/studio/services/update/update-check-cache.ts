import { config, hasConfiguredManifestCheck } from '../../public/config'
import { resolveManifestCheckResultGuarded } from './manifest-client'
import type { UpdateCheckResult } from './types'

/**
 * Shared cache for the remote update-check snapshot.
 *
 * Both `health.ts` (periodic version check) and `update.ts` (capabilities
 * endpoint) read from the same snapshot, avoiding redundant outbound
 * manifest requests on every capabilities query.
 *
 * Use cases:
 *   - `getSnapshot()` → read the last-known-good (or last-known-error) state
 *   - `refresh(force)` → trigger a manifest fetch if the TTL has expired
 *                         or unconditionally when `force` is true
 */

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface UpdateCheckSnapshot {
  result: UpdateCheckResult | null
  remoteError: string
}

let snapshot: UpdateCheckSnapshot = { result: null, remoteError: '' }
let lastRefreshedAt = 0
let pendingRefresh: Promise<UpdateCheckSnapshot> | null = null

export function getSnapshot(): UpdateCheckSnapshot {
  return snapshot
}

export async function refresh(force = false): Promise<UpdateCheckSnapshot> {
  const now = Date.now()
  if (!force && lastRefreshedAt > 0 && now - lastRefreshedAt < CACHE_TTL_MS) {
    return snapshot
  }
  if (pendingRefresh) return pendingRefresh

  pendingRefresh = doRefresh().finally(() => {
    pendingRefresh = null
  })
  return pendingRefresh
}

async function doRefresh(): Promise<UpdateCheckSnapshot> {
  if (!config.update.enabled || !hasConfiguredManifestCheck(config.update)) {
    snapshot = { result: null, remoteError: '' }
    lastRefreshedAt = Date.now()
    return snapshot
  }
  try {
    const result = await resolveManifestCheckResultGuarded(config.update)
    snapshot = { result, remoteError: '' }
    if (result.warnings?.includes('manifest_pinned_stale')) {
      // eslint-disable-next-line no-console
      console.warn(
        `[update] manifest pinned to ${result.pinnedManifestUrl}; ` +
          `preferring channel tip ${result.latestVersion} (${result.effectiveManifestUrl})`,
      )
    }
  } catch (error) {
    snapshot = { result: null, remoteError: error instanceof Error ? error.message : String(error) }
  }
  lastRefreshedAt = Date.now()
  return snapshot
}
