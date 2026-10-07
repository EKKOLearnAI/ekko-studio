import type {
  AgentTool,
  AgentToolAuthorizer,
  AgentToolContext,
  AgentToolProvider,
  AgentToolResult,
} from './types'
import { UpdatePlanTool } from './plan'
import { createBrowserTools } from './browser'
import { createClarificationToolProvider } from './clarify'
import { CodeExecTool, type CodeExecToolOptions } from './code-exec'
import { createDelegationTools } from './delegation'
import { createFileTools } from './files'
import { createImageTools } from './images'
import { createMcpToolProvider } from './mcp'
import { createRecoveryTools } from './recovery'
import { createSkillTools } from './skills'
import { createTerminalTools } from './terminal'
import type { EkkoExternalSkillDirectory } from '../skills/external-directories'
import type { EkkoRecoveryService } from '../recovery'

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>()
  private readonly providers = new Map<string, AgentToolProvider>()
  private readonly providerTools = new Map<string, Set<string>>()
  private readonly exclusiveTools = new Map<string, AgentTool>()

  constructor(private authorizer?: AgentToolAuthorizer) {}

  setAuthorizer(authorizer?: AgentToolAuthorizer): void {
    this.authorizer = authorizer
  }

  register(tool: AgentTool): void {
    const owner = this.exclusiveTools.get(tool.definition.name)
    if (owner && owner !== tool) throw new Error(`Context manager tool collision: ${tool.definition.name}`)
    this.tools.set(tool.definition.name, tool)
  }

  /** Reserve a context tool against replacement by providers, skills or built-ins. */
  registerExclusive(tool: AgentTool, previous?: AgentTool): void {
    const existing = this.tools.get(tool.definition.name)
    if (existing && existing !== previous) throw new Error(`Context manager tool collision: ${tool.definition.name}`)
    this.exclusiveTools.set(tool.definition.name, tool)
    this.tools.set(tool.definition.name, tool)
  }

  /** Copy registry state and authorization, not run-local external tool ownership. */
  fork(excludedNames: string[] = []): AgentToolRegistry {
    const registry = new AgentToolRegistry(this.authorizer)
    const excluded = new Set(excludedNames)
    for (const [name, tool] of this.tools) {
      if (excluded.has(name)) continue
      registry.register(tool instanceof CodeExecTool
        ? tool.fork((toolName, input, context) => registry.execute(toolName, input, context))
        : tool)
    }
    for (const provider of this.providers.values()) registry.registerProvider(provider)
    for (const [id, names] of this.providerTools) registry.providerTools.set(id, new Set(names))
    return registry
  }

  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  unregister(name: string): boolean {
    if (this.exclusiveTools.has(name)) throw new Error(`Context manager tool collision: ${name}`)
    return this.tools.delete(name)
  }

  registerProvider(provider: AgentToolProvider): void {
    this.providers.set(provider.id, provider)
  }

  unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId)
  }

  async refreshTools(context?: AgentToolContext): Promise<void> {
    for (const provider of this.providers.values()) {
      const previous = this.providerTools.get(provider.id)
      if (previous) {
        for (const name of previous) {
          if (this.exclusiveTools.has(name)) throw new Error(`Context manager tool collision: ${name}`)
          this.tools.delete(name)
        }
      }
      const tools = await provider.listTools(context)
      this.registerMany(tools)
      this.providerTools.set(provider.id, new Set(tools.map(tool => tool.definition.name)))
    }
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  definitions() {
    return [...this.tools.values()].map(tool => tool.definition)
  }

  async execute(name: string, input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        ok: false,
        content: `Unknown tool: ${name}`,
        error: `Unknown tool: ${name}`,
      }
    }
    const authorization = await this.authorizer?.(name, input, context)
    if (authorization && !authorization.approved) {
      const error = authorization.error || `Tool call denied: ${name}`
      return {
        ok: false,
        content: error,
        error,
        data: {
          authorization: {
            scope: authorization.scope,
            key: authorization.key,
            description: authorization.description,
          },
        },
      }
    }
    return tool.execute(input, context)
  }
}

export interface DefaultToolRegistryOptions {
  skillDirectory?: string
  externalSkillDirectories?: EkkoExternalSkillDirectory[]
  disabledSkillNames?: string[]
  authorizer?: AgentToolAuthorizer
  executionTimeoutMs?: number
  codeExec?: (CodeExecToolOptions & { enabled?: boolean }) | false
  recovery?: EkkoRecoveryService
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): AgentToolRegistry {
  const registry = new AgentToolRegistry(options.authorizer)
  for (const tool of [
    new UpdatePlanTool(),
    ...createFileTools(),
    ...createImageTools(),
    ...createTerminalTools({ timeoutMs: options.executionTimeoutMs }),
    ...createBrowserTools(),
    ...createDelegationTools(),
    ...(options.recovery ? createRecoveryTools(options.recovery) : []),
    ...createSkillTools(options.skillDirectory, {
      externalSkillDirectories: options.externalSkillDirectories,
      disabledSkillNames: options.disabledSkillNames,
    }),
  ]) {
    registry.register(tool)
  }
  if (options.codeExec !== false && options.codeExec?.enabled !== false) {
    registry.register(new CodeExecTool({
      ...options.codeExec,
      dispatch: (name, input, context) => registry.execute(name, input, context),
    }))
  }
  registry.registerProvider(createClarificationToolProvider())
  registry.registerProvider(createMcpToolProvider())
  return registry
}
