import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMcpExtension, getAgentDir } from '@earendil-works/pi-coding-agent'

function readJson(path) {
  try {
    if (statSync(path).size > 1048576) throw new Error('Pi configuration exceeds 1 MiB')
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi configuration')
    return value
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}

/** Native Pi extension. It uses only Pi's public extension API and never changes native MCP files. */
export default async function studio(pi) {
  if (!process.env.STUDIO_PI_CONTEXT_FILE || !existsSync(process.env.STUDIO_PI_CONTEXT_FILE)) throw new Error('Pi runtime context is unavailable')
  const descriptor = readJson(process.env.STUDIO_PI_CONTEXT_FILE)
  if (descriptor.model) {
    pi.registerProvider('studio-runtime', { baseUrl: descriptor.model.baseUrl, apiKey: process.env.STUDIO_PI_MODEL_TOKEN,
      api: 'openai-responses', models: [{ id: 'studio-model', name: descriptor.model.name,
        reasoning: descriptor.model.reasoning === true, input: descriptor.model.images ? ['text', 'image'] : ['text'],
        compat: { supportsStrictMode: false, supportsOpenAIGrammarTools: false, supportsAdditionalTools: false },
        contextWindow: descriptor.model.contextWindow, maxTokens: descriptor.model.outputLimit,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  }
  if (descriptor.systemPrompt) pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\n${descriptor.systemPrompt}` }))
  // Pi's public MCP factory supplies transports, OAuth, resources, tool names and shutdown.
  // Override only configuration loading so managed entries win over native/project names.
  await createMcpExtension({ loadConfig(ctx) {
    const entries = new Map(), errors = []
    const sources = [[join(getAgentDir(), 'mcp.json'), 'global'], ...(ctx.isProjectTrusted() ? [[join(ctx.cwd, '.pi', 'mcp.json'), 'project']] : [])]
    for (const [source, scope] of sources) {
      let configuration
      try { configuration = readJson(source) } catch { errors.push(`Invalid MCP configuration: ${source}`); continue }
      for (const [name, config] of Object.entries(configuration.mcpServers || {})) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) { errors.push(`Invalid MCP server: ${name}`); continue }
        const previous = entries.get(name)
        if (scope === 'project' && previous && !config.command && !config.url && !config.type) {
          entries.set(name, { ...previous, override: source, config: { ...previous.config,
            ...Object.fromEntries(['enabled', 'exposure', 'toolExposure'].filter(key => key in config).map(key => [key, config[key]])) } })
        } else entries.set(name, { name, config, source, scope })
      }
    }
    for (const [name, config] of Object.entries(descriptor.mcpServers || {})) {
      entries.set(name, { name, config, source: import.meta.url, scope: 'extension' })
    }
    return { servers: [...entries.values()], errors }
  } })(pi)
  writeFileSync(`${process.env.STUDIO_PI_CONTEXT_FILE}.ready`, descriptor.nonce, { mode: 0o600 })
}
