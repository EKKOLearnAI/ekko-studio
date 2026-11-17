import { expect, it } from 'vitest'
import { browserRelayDocument, revokesRemoteBrowserGrant } from '../../packages/desktop/src/main/browser-remote-navigation'

it('allows the main Studio document for both local and remote deployments', () => {
  expect(browserRelayDocument('http://127.0.0.1:8748/#/studio/plugins', 'http://127.0.0.1:8748', true)).toBe('http://127.0.0.1:8748')
  expect(browserRelayDocument('https://studio.example/app/#/chat', 'https://studio.example/app/', true)).toBe('https://studio.example/app/')
})
it('rejects other documents, subframes and an unavailable Studio server', () => {
  expect(() => browserRelayDocument('http://127.0.0.1:9999/', 'http://127.0.0.1:8748', true)).toThrow('main Studio document')
  expect(() => browserRelayDocument('https://evil.example/', 'https://studio.example/', true)).toThrow('main Studio document')
  expect(() => browserRelayDocument('https://studio.example/', 'https://studio.example/', false)).toThrow('main Studio document')
  expect(() => browserRelayDocument('file:///tmp/preview.html', null, true)).toThrow('main Studio document')
})
it('retains router navigation and revokes a replaced main document', () => {
  expect(revokesRemoteBrowserGrant(true, true)).toBe(false)
  expect(revokesRemoteBrowserGrant(false, false)).toBe(false)
  expect(revokesRemoteBrowserGrant(false, true)).toBe(true)
})
