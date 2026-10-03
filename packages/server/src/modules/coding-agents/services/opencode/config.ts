import type { CodingAgentContextPolicy } from '../context-policy'

export const OPENCODE_PROVIDER_ID = 'hermes-studio'
export const OPENCODE_CONFIG_FILE = 'opencode.json'
export const OPENCODE_DATABASE_FILE = 'opencode.db'
export const OPENCODE_API_KEY_ENV = 'HERMES_OPENCODE_API_KEY'
export const OPENCODE_RUNTIME_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'
export const OPENCODE_SHARED_CONFIG_DIRS = [
  'agent',
  'agents',
  'command',
  'commands',
  'plugin',
  'plugins',
  'skill',
  'skills',
] as const

export function opencodeMcpServerConfig(server: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const command = typeof server.command === 'string' ? server.command : ''
  const args = Array.isArray(server.args) ? server.args.map(String) : []
  if (command) {
    return {
      type: 'local',
      command: [command, ...args],
      enabled,
      ...(typeof server.timeout === 'number' ? { timeout: server.timeout } : {}),
      ...(server.env && typeof server.env === 'object' && !Array.isArray(server.env)
        ? { environment: server.env }
        : {}),
    }
  }
  return {
    type: 'remote',
    url: String(server.url || ''),
    enabled,
    ...(typeof server.timeout === 'number' ? { timeout: server.timeout } : {}),
    ...(server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
      ? { headers: server.headers }
      : {}),
  }
}

export function parseOpenCodeConfig(...contents: Array<string | null | undefined>): Record<string, any> {
  let config: Record<string, any> = {}
  for (const content of contents) {
    if (!content?.trim()) continue
    try {
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      config = {
        ...config,
        ...parsed,
        provider: {
          ...(config.provider && typeof config.provider === 'object' ? config.provider : {}),
          ...(parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : {}),
        },
        mcp: {
          ...(config.mcp && typeof config.mcp === 'object' ? config.mcp : {}),
          ...(parsed.mcp && typeof parsed.mcp === 'object' ? parsed.mcp : {}),
        },
      }
    } catch {
      // Invalid user JSON remains editable and is ignored only for launch-time merging.
    }
  }
  return config
}

export function parseEditableOpenCodeConfig(content: string): Record<string, any> {
  try {
    const parsed = JSON.parse(content || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  const err = new Error('OpenCode configuration contains invalid JSON')
  ;(err as any).status = 400
  throw err
}

export function openCodeSettingsConfig(content: string): string {
  const config = parseEditableOpenCodeConfig(content)
  delete config.mcp
  return `${JSON.stringify(config, null, 2)}\n`
}

export function mergeOpenCodeSettingsConfig(existingContent: string, settingsContent: string): string {
  const existing = parseEditableOpenCodeConfig(existingContent)
  const settings = parseEditableOpenCodeConfig(settingsContent)
  delete settings.mcp
  const merged: Record<string, any> = { ...settings }
  if (Object.prototype.hasOwnProperty.call(existing, 'mcp')) merged.mcp = existing.mcp
  else delete merged.mcp
  return `${JSON.stringify(merged, null, 2)}\n`
}

export function openCodeRuntimeEnv(input: {
  configDir: string
  databasePath: string
  runtimeConfig?: string
  apiKey?: string
}): Record<string, string> {
  // OPENCODE_CONFIG_DIR is OpenCode's native global-config override. Keep it
  // stable at the provider/profile root so OpenCode installs its plugin SDK
  // once and discovers the same agents, commands, plugins, skills, memory, and
  // MCP configuration for terminal, chat, group-chat, and workflow launches.
  //
  // Per-conversation provider credentials and model selection are applied with
  // OPENCODE_CONFIG_CONTENT, which OpenCode intentionally loads last. The
  // native database remains isolated per conversation. Do not redirect HOME or
  // XDG because that would also redirect git, ssh, npm, and child shells.
  return {
    OPENCODE_CONFIG_DIR: input.configDir,
    OPENCODE_DB: input.databasePath,
    ...(input.runtimeConfig ? { [OPENCODE_RUNTIME_CONFIG_ENV]: input.runtimeConfig } : {}),
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...(input.apiKey ? { [OPENCODE_API_KEY_ENV]: input.apiKey } : {}),
  }
}

export function createOpenCodeConfig(host: {
  managedServerNames: ReadonlySet<string>
  managedMcp(profile: string, tokenFile?: string): Record<string, unknown>
  displayNameForModel(model: string): string
}) {
  function opencodeRuntimeConfig(
    profile: string,
    runtime: {
      provider?: string
      model?: string
      baseUrl?: string
      systemPrompt?: string
      contextPolicy?: CodingAgentContextPolicy
      studioMcpTokenFile?: string
    },
    ...existingContents: Array<string | null | undefined>
  ): string {
    const config = parseOpenCodeConfig(...existingContents)
    const externalMcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
      ? { ...config.mcp }
      : {}
    for (const name of host.managedServerNames) delete externalMcp[name]
    const managedMcp = host.managedMcp(profile, runtime.studioMcpTokenFile)
    const inheritedInstructions = Array.isArray(config.instructions)
      ? config.instructions.map(String)
      : typeof config.instructions === 'string'
        ? [config.instructions]
        : []
    if (runtime.model) {
      delete config.model
      delete config.provider
    }
    delete config.instructions
    return `${JSON.stringify({
      ...config,
      $schema: 'https://opencode.ai/config.json',
      ...(runtime.model ? {
        model: `${OPENCODE_PROVIDER_ID}/${runtime.model}`,
        provider: {
          [OPENCODE_PROVIDER_ID]: {
            npm: '@ai-sdk/openai',
            name: runtime.provider || 'Ekko Studio',
            options: {
              baseURL: runtime.baseUrl || '',
              apiKey: `{env:${OPENCODE_API_KEY_ENV}}`,
            },
            models: {
              [runtime.model]: {
                name: host.displayNameForModel(runtime.model),
                // Always forward images; let the upstream model handle support.
                attachment: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                ...(runtime.contextPolicy ? { limit: {
                  context: runtime.contextPolicy.contextWindow,
                  input: runtime.contextPolicy.contextWindow,
                  output: runtime.contextPolicy.outputLimit,
                } } : {}),
              },
            },
          },
        },
      } : {}),
      ...(runtime.contextPolicy ? { compaction: {
        ...(config.compaction && typeof config.compaction === 'object' ? config.compaction : {}),
        auto: true,
        reserved: runtime.contextPolicy.contextWindow - runtime.contextPolicy.triggerTokens,
      } } : {}),
      ...((inheritedInstructions.length || runtime.systemPrompt) ? {
        instructions: [...new Set([
          ...inheritedInstructions,
          ...(runtime.systemPrompt ? [runtime.systemPrompt] : []),
        ])],
      } : {}),
      mcp: {
        ...externalMcp,
        ...managedMcp,
      },
      permission: { '*': 'allow' },
    }, null, 2)}\n`
  }
  return { opencodeRuntimeConfig }
}
