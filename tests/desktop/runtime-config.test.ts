import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HERMES_SOURCE_COMMIT,
  DEFAULT_HERMES_SOURCE_REF,
  DEFAULT_HERMES_SOURCE_REPOSITORY,
  DEFAULT_HERMES_VERSION,
  hermesSource,
} from '../../packages/desktop/scripts/runtime-config.mjs'

describe('desktop Hermes source configuration', () => {
  it('pins an immutable upstream release by default', () => {
    expect(DEFAULT_HERMES_VERSION).toBe('0.22.5')
    expect(DEFAULT_HERMES_SOURCE_REF).toBe('v0.22.5')
    expect(DEFAULT_HERMES_SOURCE_COMMIT).toBe('bf0203a794a07aac3ff764972ab9087baa4e4f4e')
    expect(hermesSource({})).toEqual({
      version: DEFAULT_HERMES_VERSION,
      repository: DEFAULT_HERMES_SOURCE_REPOSITORY,
      ref: DEFAULT_HERMES_SOURCE_REF,
      commit: DEFAULT_HERMES_SOURCE_COMMIT,
    })
    expect(DEFAULT_HERMES_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('rejects a partial release override', () => {
    expect(() => hermesSource({
      HERMES_VERSION: '0.20.0',
    })).toThrow(/HERMES_SOURCE_REF, HERMES_SOURCE_COMMIT/)
  })

  it('accepts an atomic version, ref, and commit override', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    expect(hermesSource({
      HERMES_VERSION: '0.20.0',
      HERMES_SOURCE_REF: 'v2026.8.1',
      HERMES_SOURCE_COMMIT: commit.toUpperCase(),
    })).toEqual({
      version: '0.20.0',
      repository: DEFAULT_HERMES_SOURCE_REPOSITORY,
      ref: 'v2026.8.1',
      commit,
    })
  })
})
