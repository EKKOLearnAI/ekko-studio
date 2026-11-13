import { openRouterAttributionHeaders as upstreamAttributionHeaders } from '../../../../../ekko-agent/src/model/openrouter-attribution'

export const OPENROUTER_APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/tangledup-ai/hermes-web-ui',
  'X-OpenRouter-Title': 'Quanthermes Web UI',
  'X-OpenRouter-Categories': 'cli-agent,personal-agent',
} as const

export function openRouterAttributionHeaders(baseUrl: string, provider?: string): Record<string, string> {
  return Object.keys(upstreamAttributionHeaders(baseUrl, provider)).length
    ? { ...OPENROUTER_APP_HEADERS }
    : {}
}
