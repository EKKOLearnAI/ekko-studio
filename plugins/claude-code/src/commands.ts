import { createHash } from 'node:crypto'
import { StudioError, type AgentRuntimeContext, type CommandDefinition, type CommandHandler } from '@ekko-studio/plugin-sdk'

const submit = (nativeName: string): CommandHandler => async (input, ctx) => {
  if (!ctx.session.instanceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Claude command requires an instance chat')
  await ctx.runs.start({ instanceId: ctx.session.instanceId, input: { content: [{ type: 'text', text: `/${nativeName}${input.rawArguments}` }] }, idempotencyKey: ctx.scope.scopeId })
  return { command: input.command, action: 'submitted', ok: true, message: '', terminal: false }
}
export const compactCommand = { definition: { id: 'studio.agent-claude-code/compact', name: 'compact', description: 'Compact the current Claude Code conversation', argsHint: '[summarization instructions]', agentTypeIds: ['claude-code'] }, handler: submit('compact') }

export function claudeCommands(runtime: AgentRuntimeContext) {
  let pending = Promise.resolve(), failure: unknown, queued = 0
  return {
    update(value: unknown) {
      if (!Array.isArray(value) || value.length > 4096) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude command catalog')
      const names = new Set<string>(), commands: Array<{ definition: CommandDefinition; handler: CommandHandler }> = []
      // The native CLI resolves its own builtin name before a same-name plugin skill.
      for (const command of [...value].sort((a, b) => Number(!!b?.builtin) - Number(!!a?.builtin))) {
        if (!command || typeof command.name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,127}$/u.test(command.name)
          || names.has(command.name) || typeof command.description !== 'string') continue
        names.add(command.name)
        if (command.name === 'compact') continue
        const aliases = Array.isArray(command.aliases) ? command.aliases.filter((alias: unknown) => typeof alias === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,127}$/u.test(alias)).slice(0, 16) : []
        commands.push({ definition: { id: `studio.agent-claude-code/native-${createHash('sha256').update(command.name).digest('hex').slice(0, 32)}`, name: command.name,
          description: command.description.slice(0, 512) || command.name, ...(typeof command.argumentHint === 'string' && command.argumentHint ? { argsHint: command.argumentHint.slice(0, 256) } : {}),
          ...(aliases.length ? { aliases } : {}), agentTypeIds: ['claude-code'] }, handler: submit(command.name) })
        if (commands.length >= 64) break
      }
      if (runtime.commands) {
        if (queued >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude command update limit exceeded')
        queued++; pending = pending.then(() => runtime.commands!.replace(commands)).catch(error => { failure = error }).finally(() => { queued-- })
      }
    },
    async drain() { await pending; if (failure) throw failure },
  }
}
