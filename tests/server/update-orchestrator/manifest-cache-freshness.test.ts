/**
 * Seam tests for manifest cache freshness classification (phase a).
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Manifest cache).
 * Thresholds: < 24h green, < 7d yellow, < 30d orange, >= 30d red.
 */
import { describe, expect, it } from 'vitest'
import { manifestCacheFreshness } from '../../../packages/server/src/modules/studio/services/update/manifest-cache-freshness'

const NOW = new Date('2026-09-06T12:00:00Z')

describe('manifestCacheFreshness', () => {
  it('green under 24 hours', () => {
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 1000), NOW)).toBe('green')
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 23 * 3600 * 1000), NOW)).toBe('green')
  })

  it('yellow from 24 hours to 7 days', () => {
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 24 * 3600 * 1000), NOW)).toBe('yellow')
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 6.9 * 24 * 3600 * 1000), NOW)).toBe('yellow')
  })

  it('orange from 7 days to 30 days', () => {
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 7 * 24 * 3600 * 1000), NOW)).toBe('orange')
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 29 * 24 * 3600 * 1000), NOW)).toBe('orange')
  })

  it('red at 30 days and beyond', () => {
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 30 * 24 * 3600 * 1000), NOW)).toBe('red')
    expect(manifestCacheFreshness(new Date(NOW.getTime() - 400 * 24 * 3600 * 1000), NOW)).toBe('red')
  })

  it('red for missing or unparseable timestamps', () => {
    expect(manifestCacheFreshness(null, NOW)).toBe('red')
    expect(manifestCacheFreshness(undefined, NOW)).toBe('red')
    expect(manifestCacheFreshness('not-a-date', NOW)).toBe('red')
  })

  it('never reports a negative age (future timestamp is green)', () => {
    expect(manifestCacheFreshness(new Date(NOW.getTime() + 3600 * 1000), NOW)).toBe('green')
  })

  it('accepts ISO strings directly', () => {
    expect(manifestCacheFreshness('2026-09-06T10:00:00Z', NOW)).toBe('green')
  })
})
