/**
 * Manifest cache freshness classification for the phase (a) update system.
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Download & Resume →
 * Manifest cache). The device caches the last successfully fetched channel
 * manifest; when the network is down the cached copy keeps serving and the
 * UI communicates staleness through these four levels.
 *
 * Settled semantics: freshness never blocks an update — red only changes
 * UI urgency. The operator can still apply.
 */

export type ManifestCacheFreshness = 'green' | 'yellow' | 'orange' | 'red'

export const MANIFEST_FRESHNESS_THRESHOLDS = {
  greenMaxMs: 24 * 60 * 60 * 1000,
  yellowMaxMs: 7 * 24 * 60 * 60 * 1000,
  orangeMaxMs: 30 * 24 * 60 * 60 * 1000,
} as const

export function manifestCacheFreshness(
  cachedAt: Date | number | string | null | undefined,
  now: Date = new Date(),
): ManifestCacheFreshness {
  if (cachedAt == null) return 'red'
  const cached = cachedAt instanceof Date ? cachedAt.getTime() : Date.parse(String(cachedAt))
  if (!Number.isFinite(cached)) return 'red'
  const ageMs = Math.max(now.getTime() - cached, 0)
  if (ageMs < MANIFEST_FRESHNESS_THRESHOLDS.greenMaxMs) return 'green'
  if (ageMs < MANIFEST_FRESHNESS_THRESHOLDS.yellowMaxMs) return 'yellow'
  if (ageMs < MANIFEST_FRESHNESS_THRESHOLDS.orangeMaxMs) return 'orange'
  return 'red'
}
