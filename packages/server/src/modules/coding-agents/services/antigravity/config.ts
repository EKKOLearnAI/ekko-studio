import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeManagedPromptFile } from '../prompt-file'

export const ANTIGRAVITY_INSTALL_URL = 'https://antigravity.google/docs/cli/install'
export const ANTIGRAVITY_DEFAULT_SETTINGS = '{\n  "toolPermission": "request-review"\n}\n'

export function parseAntigravityConfig(content: string): Record<string, any> {
  try {
    const value = JSON.parse(content.replace(/^\uFEFF/, "").trim() || "{}")
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
    return value
  } catch {
    throw Object.assign(new Error('Antigravity configuration must be a valid JSON object'), { status: 400 })
  }
}

export function validateAntigravitySettings(content: string): void {
  parseAntigravityConfig(content)
}

/** Keep per-run MCP/instructions private, while native authentication and sessions
 * remain owned by the official CLI. Never mutate the user's settings or MCP file. */
export async function prepareAntigravityRuntime(input: {
  home: string
  rootDir: string
  systemPrompt: string
  managedMcp: Record<string, unknown>
  externalModel?: { baseUrl: string; token: string }
}): Promise<{ env: Record<string, string>; files: Array<{ key: string; path: string; absolutePath: string }>; promptFile: string }> {
  const source = join(input.home, '.gemini')
  const shadow = join(input.rootDir, '.gemini')
  await mkdir(shadow, { recursive: true })
  if (!input.externalModel) await mkdir(join(source, 'antigravity'), { recursive: true })
  // Preserve native state/auth paths; do not copy secrets into generated config.
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (input.externalModel) continue
    if (entry.name === 'config' || entry.name === 'antigravity-cli') continue
    await symlink(join(source, entry.name), join(shadow, entry.name), entry.isDirectory() ? 'junction' : 'file').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  for (const directory of ['config', 'antigravity-cli']) {
    await mkdir(join(shadow, directory), { recursive: true })
    for (const entry of await readdir(join(source, directory), { withFileTypes: true }).catch(() => [])) {
      if (input.externalModel && directory === 'antigravity-cli') continue
      if (entry.name === 'mcp_config.json' || entry.name === 'settings.json' || entry.name === 'AGENTS.md' || entry.name === 'skills') continue
      await symlink(join(source, directory, entry.name), join(shadow, directory, entry.name), entry.isDirectory() ? 'junction' : 'file').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  }
  const settings = await readFile(join(source, 'antigravity-cli', 'settings.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return ANTIGRAVITY_DEFAULT_SETTINGS
  })
  validateAntigravitySettings(settings)
  const userMcp = await readFile(join(source, 'config', 'mcp_config.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return '{}'
  })
  validateAntigravitySettings(userMcp)
  const root = parseAntigravityConfig(userMcp)
  const skillRoot = join(shadow, 'config', 'skills')
  await mkdir(skillRoot, { recursive: true })
  for (const skills of [join(source, 'config', 'skills'), join(input.home, '.agents', 'skills')]) {
    for (const entry of await readdir(skills, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      await symlink(join(skills, entry.name), join(skillRoot, entry.name), 'junction').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  }
  const mcpPath = join(shadow, 'config', 'mcp_config.json')
  const settingsPath = join(shadow, 'antigravity-cli', 'settings.json')
  const promptFile = join(shadow, 'config', 'AGENTS.md')
  const userRules = await readFile(join(source, 'config', 'AGENTS.md'), 'utf8').catch(() => '')
  const runtimeSettings = parseAntigravityConfig(settings)
  if (input.externalModel) runtimeSettings.modelProvider = 'gemini'
  // Only grant Studio's injected MCP servers, not shell/file tools. Existing
  // deny rules are preserved and remain authoritative.
  const permissions = runtimeSettings.permissions || {}
  runtimeSettings.permissions = { ...permissions, allow: [...new Set([
    ...(Array.isArray(permissions.allow) ? permissions.allow : []),
    ...Object.entries(input.managedMcp).filter(([, value]) => !(value as any)?.disabled).map(([name]) => `mcp(${name}/*)`),
  ])] }
  await writeFile(settingsPath, JSON.stringify(runtimeSettings, null, 2), { mode: 0o600 })
  const managedMcp = Object.fromEntries(Object.entries(input.managedMcp).map(([name, value]) => {
    const config = { ...(value as Record<string, unknown>) }
    if (config.url) { config.serverUrl = config.url; delete config.url }
    if (typeof config.enabled === 'boolean') { config.disabled = !config.enabled; delete config.enabled }
    return [name, config]
  }))
  await writeFile(mcpPath, JSON.stringify({ ...root, mcpServers: { ...(root.mcpServers || {}), ...managedMcp } }, null, 2), { mode: 0o600 })
  await writeManagedPromptFile(promptFile, input.systemPrompt, userRules)
  return {
    env: { HOME: input.rootDir, USERPROFILE: input.rootDir,
      ...(input.externalModel ? { GEMINI_API_KEY: input.externalModel.token, GOOGLE_GEMINI_BASE_URL: input.externalModel.baseUrl } : {}) },
    promptFile,
    files: [
      { key: 'settings', path: '.gemini/antigravity-cli/settings.json', absolutePath: settingsPath },
      { key: 'mcp', path: '.gemini/config/mcp_config.json', absolutePath: mcpPath },
      { key: 'prompt', path: '.gemini/config/AGENTS.md', absolutePath: promptFile },
    ],
  }
}
