import type { Disposer, ExecutionContext, JsonValue } from './types'

/** Metadata only. The plugin handler owns argument parsing and execution. */
export interface CommandDefinition {
  id: string
  name: string
  description: string
  argsHint?: string
  aliases?: string[]
  /** Omitted means any owned direct chat. Restricted types must belong to this plugin. */
  agentTypeIds?: string[]
}
export interface CommandInput { text: string; command: string; rawArguments: string }
/** Existing session.command payload, without host-owned transport/identity fields. */
export interface CommandResult {
  command: string
  action: string
  ok: boolean
  message: string
  messageKey?: string
  started?: boolean
  terminal?: boolean
  [field: string]: JsonValue | undefined
}
export interface CommandContext extends ExecutionContext {
  readonly session: { readonly agentTypeId: string; readonly isWorking: boolean; readonly instanceId?: string; readonly instanceRevision?: number }
  /** Await delivery; late/unawaited replies after handler completion are rejected. */
  reply(result: CommandResult): Promise<void>
}
export type CommandHandler = (input: CommandInput, context: CommandContext) => CommandResult | void | Promise<CommandResult | void>
export interface CommandContributions { register(definition: CommandDefinition, handler: CommandHandler): Disposer }
/** Atomic runtime catalog. Handlers stay in the plugin and expire with its lease. */
export interface RuntimeCommandContributions {
  replace(commands: Array<{ definition: CommandDefinition; handler: CommandHandler }>): Promise<void>
}
