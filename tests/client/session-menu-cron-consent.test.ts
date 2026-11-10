import { describe, expect, it } from 'vitest'
import { buildActiveSessionMenuOptions } from '../../packages/client/src/components/hermes/chat/session-menu-options'

const labels = { outline: 'Outline', rename: 'Rename', open: 'Open', copyId: 'Copy', cronConsentSetup: 'Allow scheduled results' }
const keys = (options: ReturnType<typeof buildActiveSessionMenuOptions>) => options.map(option => option.key)

describe('cron consent setup in the session menu', () => {
  it('is offered only for sessions that can receive scheduled results', () => {
    expect(keys(buildActiveSessionMenuOptions(labels, { canRename: true, canOpen: true }))).not.toContain('cron-consent-setup')
    expect(keys(buildActiveSessionMenuOptions(labels, { canRename: true, canOpen: true, canCronConsentSetup: false }))).not.toContain('cron-consent-setup')
    const options = buildActiveSessionMenuOptions(labels, { canRename: true, canOpen: true, canCronConsentSetup: true })
    const last = options.at(-1)!
    expect({ key: last.key, label: last.label, hasChildren: Array.isArray(last.children) }).toEqual({ key: 'cron-consent-setup', label: 'Allow scheduled results', hasChildren: false })
    expect(typeof last.icon).toBe('function')
  })

  it('is not offered without its label', () => {
    const { cronConsentSetup: _omitted, ...withoutLabel } = labels
    expect(keys(buildActiveSessionMenuOptions(withoutLabel, { canRename: true, canOpen: true, canCronConsentSetup: true }))).not.toContain('cron-consent-setup')
  })
})
