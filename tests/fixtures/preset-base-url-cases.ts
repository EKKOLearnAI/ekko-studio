/**
 * One corpus for the preset Base URL credential rule, run against both the
 * server copy and the client copy so the two stay identical.
 */
export const PRESET_BASE_URLS_WITH_CREDENTIALS: readonly string[] = [
  // URL userinfo, including the WHATWG shapes without `//` (special schemes accept them).
  'https://user:pass@gateway.test/v1',
  'https://token@gateway.test/v1',
  'user:pass@localhost:11434/v1',
  'https:u:p@h/v1',
  'https:/u:p@h/v1',
  'http:\\\\u:p@h/v1',
  'HTTPS:U:P@H/V1',
  'https://gateway.test@evil.test/v1',
  // Secret-looking query parameter names.
  'https://gateway.test/v1?api_key=sk-1',
  'https://gateway.test/v1?x=1&KEY=abc',
  'https://gateway.test/v1?Access_Token=abc',
  'https://gateway.test/v1?api-key=abc',
  'https://gateway.test/v1?API-KEY=abc',
  'https://gateway.test/v1?%61pi_key=abc',
  'https://gateway.test/v1?%2561pi_key=abc',
  'https://gateway.test/v1?region=eu&api_key=a&api_key=b',
  'https://gateway.test/v1?api_key=&api_key=b',
  'https://gateway.test/v1?x-api-key=abc',
  'https://x.openai.azure.com/openai?api-version=2024-10-21&subscription-key=abc',
  'https://gateway.test/v1?client_secret=abc',
  'https://gateway.test/v1?auth=abc',
  'https://gateway.test/v1?api_key[]=abc',
  'https://gateway.test/v1?sig=abc',
  'https://gateway.test/v1?signature=abc',
  'https://gateway.test/v1?password=abc',
  'https://gateway.test/v1?passwd=abc',
  'https://gateway.test/v1?secret=abc',
  'https://gateway.test/v1?token=abc',
  'https://gateway.test/v1?apikey=abc',
  'https://gateway.test/v1?credential=abc',
  'localhost:11434/v1?api_key=abc',
  // Any non-empty fragment: never sent over HTTP, so it can only carry data.
  'https://gateway.test/v1#api_key=x',
  'https://gateway.test/v1#section',
]

export const PRESET_BASE_URLS_WITHOUT_CREDENTIALS: readonly string[] = [
  'https://api.openai.com/v1',
  'http://localhost:11434/v1',
  'https://x.openai.azure.com/openai/deployments/d',
  'https://x.openai.azure.com/openai/deployments/d?api-version=2024-10-21',
  'https://gateway.test/v1?version=2',
  'https://gateway.test/v1?region=eu&format=json',
  'https://gateway.test/v1#',
  'localhost:11434/v1',
  'ftp://example.test',
  'https://gateway.test/tokens/v1',
  'https://gateway.test/@org/v1',
  'https://gateway.test/v1?email=a@b.test',
  '',
]
