/** @type {import('@ekko-studio/plugin-sdk').StudioPlugin} */
module.exports = {
  apply(ctx) {
    ctx.agents.register({
      id: 'example.echo/assistant',
      name: 'Echo',
      configSchema: { type: 'object', additionalProperties: false },
      capabilities: { text: true, streaming: true, modes: ['scoped'] },
      async create() {
        return {
          async run(input, runCtx) {
            let cancelled = false
            let finish
            const result = new Promise(resolve => { finish = resolve })
            return {
              events: (async function* () {
                try {
                  const text = (ctx.config.prefix || '') + input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
                  if (!cancelled && !runCtx.signal.aborted) yield { type: 'message.delta', producerSequence: 1, messageId: 'answer', text }
                } finally {
                  finish({ status: cancelled || runCtx.signal.aborted ? 'cancelled' : 'completed' })
                }
              })(),
              result,
              async cancel() { cancelled = true },
            }
          },
          async dispose() {},
        }
      },
    })
    ctx.on('run.completed', event => ctx.logger.info('Observed completed run', { runId: event.data.runId }))
  },
}
