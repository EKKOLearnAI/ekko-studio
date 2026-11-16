import { Readable } from 'node:stream'
import { gatewayToken, type ModelGatewayAdapters } from '../../studio/public/model-gateway-adapters'
import { reasoningCodec } from '../../studio/public/model-reasoning-codec'
import type { ApiMode } from '../protocol/types'
import { registerCodexProxyTarget, revokeCodexProxyTarget, findCodexProxyByToken, findCodexGatewayTarget, codexProxyResponses, codingAgentProxyChatCompletions, antigravityProxyGenerate } from './codex/proxy'
import { registerClaudeCodeProxyTarget, revokeClaudeCodeProxyTarget, findClaudeProxyByToken, findClaudeGatewayTarget, claudeProxyMessages, claudeProxyCountTokens } from './claude-code/proxy'

const targetForToken = (token: string) => findCodexProxyByToken(token) || findClaudeProxyByToken(token)

/** The Coding module owns native protocol translation and target lifetimes. */
export const codingModelGatewayAdapters: ModelGatewayAdapters = {
  authenticate: token => {
    const target = targetForToken(token)
    return target?.ownerUserId ? { userId: target.ownerUserId, profile: target.profile || 'default', agentId: target.agentId,
      sessionId: target.chatSessionId, runId: target.agentSessionId, model: target.model, provider: target.provider } : null
  },
  handle: async (protocol, ctx) => {
    ctx.params ||= {}
    const binding = targetForToken(gatewayToken(ctx)) || findCodexGatewayTarget(ctx.params.key || '') || findClaudeGatewayTarget(ctx.params.key || '')
    if (binding) ctx.state.modelGatewayReasoningCodec = await reasoningCodec(JSON.stringify([binding.ownerUserId, binding.profile, binding.provider, binding.model, binding.baseUrl, binding.apiMode]))
    if (protocol === 'gemini_contents') ctx.params.operation = ctx.path.match(/\/v1beta\/models\/(.+)$/)?.[1] || ''
    const abort = new AbortController()
    const close = () => { if (!ctx.res.writableEnded) abort.abort() }
    const cleanup = () => { abort.abort(); ctx.res.off('close', close) }
    ctx.res.once('close', close)
    ctx.state.modelGatewaySignal = abort.signal
    try {
      if (protocol === 'anthropic_messages') await (ctx.path.endsWith('/count_tokens') ? claudeProxyCountTokens(ctx) : claudeProxyMessages(ctx))
      else if (protocol === 'chat_completions') await codingAgentProxyChatCompletions(ctx)
      else if (protocol === 'gemini_contents') await antigravityProxyGenerate(ctx)
      else await codexProxyResponses(ctx)
      if (ctx.body instanceof Readable) {
        ctx.body.once('close', cleanup)
        ctx.body.once('error', cleanup)
      } else cleanup()
    } catch (error) { cleanup(); throw error }
  },
  register: (protocol, input, persisted) => {
    const targetInput = { ...input, ownerUserId: input.userId, chatSessionId: input.sessionId, agentSessionId: input.runId, apiMode: input.apiMode as ApiMode }
    const anthropic = protocol === 'anthropic_messages'
    const target = anthropic ? registerClaudeCodeProxyTarget(targetInput, persisted) : registerCodexProxyTarget(targetInput, persisted)
    return { routeKey: target.routeKey, dispose: () => { if (anthropic) revokeClaudeCodeProxyTarget(target.routeKey); else revokeCodexProxyTarget(target.routeKey) } }
  },
}
