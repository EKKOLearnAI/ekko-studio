import { describe, expect, it } from 'vitest'
import { isNodeVersionRangeSatisfied } from '../../packages/server/src/modules/studio/services/update/device-package-contract'

describe('device package contract', () => {
  it('allows patch and minor updates for tilde ranges without patch drift regressions', () => {
    expect(isNodeVersionRangeSatisfied('~1', '1.5.0')).toBe(true)
    expect(isNodeVersionRangeSatisfied('~1', '2.0.0')).toBe(false)

    expect(isNodeVersionRangeSatisfied('~1.2', '1.2.9')).toBe(true)
    expect(isNodeVersionRangeSatisfied('~1.2', '1.3.0')).toBe(false)

    expect(isNodeVersionRangeSatisfied('~1.2.3', '1.2.9')).toBe(true)
    expect(isNodeVersionRangeSatisfied('~1.2.3', '1.3.0')).toBe(false)
  })

  it('applies caret upper bounds using semver-compatible left-most non-zero rules', () => {
    expect(isNodeVersionRangeSatisfied('^1', '1.9.0')).toBe(true)
    expect(isNodeVersionRangeSatisfied('^1', '2.0.0')).toBe(false)

    expect(isNodeVersionRangeSatisfied('^0.2.3', '0.2.9')).toBe(true)
    expect(isNodeVersionRangeSatisfied('^0.2.3', '0.3.0')).toBe(false)

    expect(isNodeVersionRangeSatisfied('^0.0.3', '0.0.3')).toBe(true)
    expect(isNodeVersionRangeSatisfied('^0.0.3', '0.0.4')).toBe(false)
  })
})
