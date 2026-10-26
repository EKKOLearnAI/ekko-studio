export const DSH_STREAM_METHOD = '_ekko/assistant_stream'
export const DSH_USAGE_METHOD = '_ekko/model_usage'

/** Loaded only in Studio's private ACP profile, never in the user's DSH install. */
export const DSH_STREAM_PLUGIN = `
import { randomUUID } from 'node:crypto'
export const name = 'ekko-studio-assistant-stream'
export function apply(ctx) {
  // Includes compaction and child model calls, with the same disjoint buckets
  // as DSH's TokenUsage contract. Never forward prompts, content or credentials.
  ctx.on('llm/stream', async function* (options, next) {
    const requestId = randomUUID()
    const started = performance.now()
    let usage
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        yield chunk
      }
    } finally {
      // Accounting must not turn a successful model stream into a failure, or
      // replace its original error if serialization/the notification fails.
      try { if (usage) process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: '${DSH_USAGE_METHOD}', params: {
          requestId, sessionId: options.sessionId, model: options.model, provider: options.provider,
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens },
          apiDuration: (performance.now() - started) / 1000,
        },
      }) + '\\n') } catch { /* Usage stays unknown when reporting fails. */ }
    }
  })
  const attempts = new WeakMap()
  const notify = (session, frame) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: '${DSH_STREAM_METHOD}',
    params: { sessionId: session.header.id, frame },
  }) + '\\n')
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent.session
    if (frame.type === 'start') {
      attempts.set(session, frame.attemptId)
      notify(session, { type: 'start', attemptId: frame.attemptId })
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        notify(session, { type: chunk.type, attemptId: frame.attemptId, text: chunk.text })
      }
    } else if (frame.type === 'end') {
      attempts.delete(session)
      notify(session, { type: 'end', attemptId: frame.attemptId })
    }
  })
  // DSH queues ACP projections asynchronously after this synchronous durable event.
  // Link the live attempt to the ACP message ID before its final blocks arrive.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const attemptId = attempts.get(session)
    if (attemptId) notify(session, { type: 'commit', attemptId, messageId: event.data.message.id })
  })
}
`
