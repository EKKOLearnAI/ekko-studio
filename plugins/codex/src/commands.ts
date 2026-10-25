import { StudioError, type CommandDefinition, type CommandHandler, type AgentRunInput } from '@ekko-studio/plugin-sdk'

export const compactCommand: { definition: CommandDefinition; handler: CommandHandler } = {
  definition: { id: 'studio.agent-codex/compact', name: 'compact', description: 'Compact the current Codex conversation', agentTypeIds: ['codex'] },
  async handler(input, ctx) {
    if (input.rawArguments.trim()) throw new StudioError('INVALID_ARGUMENT', 'Codex compact does not accept arguments')
    if (!ctx.session.instanceId) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Codex compact requires an instance chat')
    await ctx.runs.start({ instanceId: ctx.session.instanceId, input: { content: [{ type: 'text', text: '/compact' }] }, idempotencyKey: ctx.scope.scopeId })
    return { command: input.command, action: 'submitted', ok: true, message: '', terminal: false }
  },
}

export function isCompact(input: AgentRunInput): boolean {
  const text = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (!/^\/compact(?:\s|$)/.test(text)) return false
  if (input.content.some(block => block.type !== 'text') || text.trim() !== '/compact') throw new StudioError('INVALID_ARGUMENT', 'Codex compact accepts no arguments or images')
  return true
}
