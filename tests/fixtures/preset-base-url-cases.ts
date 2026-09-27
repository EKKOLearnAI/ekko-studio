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
  'https://gateway.test/v1?accessToken=abc',
  'https://gateway.test/v1?XApiKey=abc',
  'https://gateway.test/v1?session_token=abc',
  'https://gateway.test/v1?authorization=abc',
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
  // Token-boundary matching: a secret word inside a longer word is not a secret.
  'https://gateway.test/v1?design=a&author=b&keyspace=c',
  'https://gateway.test/v1?monkey=1&authuser=0&max_tokens=512',
  '',
]

/** Parameter names the rule must treat as secrets (server and client). */
export const SECRET_LIKE_PARAM_NAMES: readonly string[] = [
  'api_key', 'x-api-key', 'X-API-Key', 'XApiKey', 'Subscription-Key', 'subscription_key', 'client_secret', 'clientsecret',
  'auth', 'AUTH', 'api_key[]', '%61pi_key', '%2561pi_key', 'apikey', 'APIKEY', 'key', 'signature', 'sig',
  'token', 'access_token', 'access-token', 'accessToken', 'accesstoken', 'authtoken', 'session_token', 'sessiontoken',
  'password', 'passwd', 'pwd', 'secret', 'credential', 'credentials', 'authorization', 'user_pwd',
]

/** Parameter names that only contain a secret word inside a longer word, or none at all. */
export const SAFE_PARAM_NAMES: readonly string[] = [
  'design', 'author', 'keyspace', 'monkey', 'authuser', 'max_tokens', 'api-version', 'version',
  'keyboard', 'region', 'format', 'deployment', 'model', 'signal', 'tokenizer', 'passage',
]
