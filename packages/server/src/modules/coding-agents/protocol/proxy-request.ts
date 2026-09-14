import type { Context } from 'koa'
import type { AgentGatewayRequest } from './gateway'
import type { AgentTargetInput } from './target-registry'

const CLIENT_IDENTITY_HEADERS = {
  codex: [
    'user-agent', 'originator', 'openai-beta', 'x-openai-client-user-agent',
    'x-codex-beta-features', 'x-codex-window-id', 'x-codex-turn-metadata',
    'session-id', 'thread-id', 'x-client-request-id',
  ],
  'claude-code': [
    'user-agent', 'x-app', 'anthropic-version', 'anthropic-beta',
    'anthropic-dangerous-direct-browser-access', 'x-claude-code-session-id',
    'x-stainless-lang', 'x-stainless-package-version', 'x-stainless-os',
    'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
  ],
} as const

export type ProxyRequestOptions = Pick<AgentGatewayRequest, 'headers' | 'proxyUrl' | 'signal'>

export function proxyRequestOptions(
  ctx: Context,
  target: AgentTargetInput,
  client: keyof typeof CLIENT_IDENTITY_HEADERS,
): ProxyRequestOptions {
  const headers: Record<string, string> = {}
  if (target.preserveClientIdentity && target.agentId === client) {
    for (const name of CLIENT_IDENTITY_HEADERS[client]) {
      const value = ctx.get(name).trim()
      if (value) headers[name] = value
    }
  }

  const controller = new AbortController()
  const cleanup = () => {
    ctx.req?.off('aborted', abort)
    ctx.res?.off('close', close)
    ctx.res?.off('finish', cleanup)
  }
  const abort = () => {
    controller.abort()
    cleanup()
  }
  const close = () => {
    if (!ctx.res?.writableEnded) controller.abort()
    cleanup()
  }
  // IncomingMessage.close also fires after a normal request body; only an
  // aborted request or an unfinished response closing cancels upstream work.
  ctx.req?.once('aborted', abort)
  ctx.res?.once('close', close)
  ctx.res?.once('finish', cleanup)
  if (ctx.req?.aborted || ctx.res?.destroyed) abort()

  return {
    headers: { ...headers, ...target.extraHeaders },
    proxyUrl: target.proxyUrl,
    signal: controller.signal,
  }
}
