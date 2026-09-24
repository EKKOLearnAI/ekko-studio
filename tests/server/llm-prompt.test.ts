import { studioMcpCapabilities } from '../../packages/server/src/modules/studio/public/runs/mcp-capabilities'
import { describe, expect, it } from 'vitest'
import { getSystemPrompt } from '../../packages/server/src/modules/studio/public/runs/prompt'

describe('LLM prompt', () => {
  it('includes Hermes MCP usage guidance for enabled toolsets without runtime profile or resource URI values', () => {
    const prompt = getSystemPrompt('custom instructions', { mcpCapabilities: studioMcpCapabilities({
      'ekko-studio-api': { command: 'studio' },
      'ekko-studio-use': { command: 'studio' },
    }) })

    expect(prompt).toContain('custom instructions')
    expect(prompt).toContain('ekko_studio_api_openapi_get')
    expect(prompt).toContain('ekko_studio_api_request')
    expect(prompt).toContain('OpenAPI requestBody')
    expect(prompt).toContain('do not add Authorization headers')
    expect(prompt).toContain('Do not use ekko_studio_use_chat_run')
    expect(prompt).toContain('internal delegation mechanism')
    expect(prompt).toContain('return the delegated result in the current task instead')
    expect(prompt).not.toContain('hermes://openapi.json')
    expect(prompt).not.toContain('[Current Hermes profile:')
  })
})


it('keeps output formatting without instructions to use disabled or absent MCPs', () => {
  for (const servers of [undefined, {}, { 'ekko-studio-api': { enabled: false } }]) {
    const prompt = getSystemPrompt('user instructions', { mcpCapabilities: studioMcpCapabilities(servers) })
    expect(prompt).toContain('user instructions')
    expect(prompt).toContain('# 输出格式规范')
    expect(prompt).not.toContain('ekko_studio_')
    expect(prompt).not.toContain('Ekko Studio MCP usage')
  }
})

it('gates each toolset independently and includes lazy servers', () => {
  const capabilities = studioMcpCapabilities({
    'ekko-studio-api': { enabled: false },
    'ekko-studio-browser': { lifecycle: 'lazy' },
    'ekko-studio-interaction': { enabled: false },
    'external-api': { command: 'other' },
  })
  expect(capabilities).toEqual({ api: false, browser: true, use: false, devices: false, interaction: false })
  const prompt = getSystemPrompt(undefined, { mcpCapabilities: capabilities })
  expect(prompt).toContain('ekko_studio_browser_toolset')
  expect(prompt).not.toContain('ekko_studio_api_openapi_get')
  expect(prompt).not.toContain('ekko_studio_api_request')
})

it('recognizes migrated Studio names without enabling unrelated servers', () => {
  expect(studioMcpCapabilities({
    'hermes-studio-api': { command: 'studio' },
    'ekko-studio-plan': { command: 'studio' },
    'ekko-studio-browser': { disabled: true },
    'external-use': { command: 'other' },
  })).toEqual({ api: true, browser: false, use: false, devices: false, interaction: true })
})
