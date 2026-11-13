import { expect, it } from 'vitest'
import type { AvailableModelGroup } from '../../packages/client/src/api/hermes/system'
import { hasConfiguredProviderApiKey } from '../../packages/client/src/utils/codingAgentProviders'

const group: AvailableModelGroup = {
  provider: 'custom:cn', label: 'cn', models: ['model-a'], base_url: 'https://provider.invalid/v1', api_key: '',
}

it('accepts a profile credential that stays on the server', () => {
  expect(hasConfiguredProviderApiKey({ ...group, credential_configured: true })).toBe(true)
})

it('still accepts inline keys from existing servers', () => {
  expect(hasConfiguredProviderApiKey({ ...group, api_key: 'inline-key' })).toBe(true)
})

it('requires a key when no credential is configured in the selected profile', () => {
  expect(hasConfiguredProviderApiKey(group)).toBe(false)
  expect(hasConfiguredProviderApiKey({ ...group, credential_configured: false })).toBe(false)
  expect(hasConfiguredProviderApiKey(undefined)).toBe(false)
})
