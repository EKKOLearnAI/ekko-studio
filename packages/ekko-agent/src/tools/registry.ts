import type {
  AgentTool,
  AgentToolAuthorizer,
  AgentToolContext,
  AgentToolProvider,
  AgentToolResult,
} from './types'
import { UpdatePlanTool } from './plan'
import { createBrowserTools } from './browser'
import { ComputerUseTool, type ComputerUseToolOptions } from './computer-use'
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

  constructor(private authorizer?: AgentToolAuthorizer) {}

  setAuthorizer(authorizer?: AgentToolAuthorizer): void {
    this.authorizer = authorizer
  }

  register(tool: AgentTool): void {
    this.tools.set(tool.definition.name, tool)
  }

  registerMany(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  unregister(name: string): boolean {
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
    if (!authorization || authorization.scope === 'safe') return tool.execute(input, context)

    let result: AgentToolResult
    try {
      result = await tool.execute(input, context)
    } catch (error) {
      if (context?.signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      result = { ok: false, content: message, error: message }
    }
    // Approval events reach the UI, not the model. Carry the actual decision in
    // the persisted tool content too, even when execution after approval fails.
    const status = { approved: true, scope: authorization.scope, key: authorization.key }
    const notice = `Tool authorization at execution: ${JSON.stringify(status)}`
    let content = `${notice}\n${result.content}`
    try {
      const payload = JSON.parse(result.content)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        // Keep JSON results parseable; never trust a tool-supplied approval field.
        const { authorization: _ignored, ...output } = payload
        content = JSON.stringify({ authorization: status, ...output })
      }
    } catch { /* Plain-text tool results retain their original text. */ }
    return {
      ...result,
      content,
      ...(result.contentParts?.length ? {
        contentParts: [...result.contentParts, { type: 'text' as const, text: notice }],
      } : {}),
    }
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
  computerUse?: ComputerUseToolOptions
}

export function createDefaultToolRegistry(options: DefaultToolRegistryOptions = {}): AgentToolRegistry {
  const registry = new AgentToolRegistry(options.authorizer)
  for (const tool of [
    new UpdatePlanTool(),
    ...createFileTools(),
    ...createImageTools(),
    ...createTerminalTools({ timeoutMs: options.executionTimeoutMs }),
    ...createBrowserTools(),
    ...(options.computerUse?.enabled === false ? [] : [new ComputerUseTool(options.computerUse)]),
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
