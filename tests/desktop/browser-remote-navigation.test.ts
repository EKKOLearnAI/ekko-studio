import { describe, expect, it } from 'vitest'
import { revokesRemoteBrowserGrant } from '../../packages/desktop/src/main/browser-remote-navigation'
describe('remote browser consent navigation boundary', () => {
  it.each([[true, true, false], [false, false, false], [true, false, false], [false, true, true]])(
    'inPlace=%s mainFrame=%s revokes=%s', (inPlace, mainFrame, revoked) => {
      expect(revokesRemoteBrowserGrant(inPlace, mainFrame)).toBe(revoked)
    },
  )
})
