const CODING_AGENT_CHILD_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LANGUAGE', 'TZ',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
])

export function isolatedCodingAgentChildEnv(
  launchEnv: NodeJS.ProcessEnv = {},
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue
    if (CODING_AGENT_CHILD_ENV_KEYS.has(key) || key.startsWith('LC_')) env[key] = value
  }
  for (const [key, value] of Object.entries(launchEnv)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
