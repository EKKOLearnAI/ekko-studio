export function apply(ctx) {
  // This plugin chooses per-account/Profile data. The host does not impose it.
  const storage = () => ctx.state.plugin.namespace('users', String(ctx.identity.userId), 'profiles', ctx.identity.profile)
  let tail = Promise.resolve()
  function serial(work) { const next = tail.catch(() => {}).then(work); tail = next; return next }
  ctx.events.on('*', event => serial(async () => {
    const store = storage(), recent = await store.get('recent') || []
    await store.set('recent', [...recent, { type: event.type, timestamp: event.timestamp, sessionId: event.identity.sessionId || null }].slice(-50))
  }))
  async function digest() {
    const store = storage(), events = await store.get('recent') || []
    const result = { generatedAt: Date.now(), eventCount: events.length, events }
    await store.set('digest', result); ctx.log.info('Activity digest saved', { eventCount: events.length })
    return result
  }
  ctx.extensions.actions.register({ name: 'digest', description: 'Build an activity digest.', inputSchema: { type: 'object', additionalProperties: false }, execute: digest })
  ctx.extensions.commands.register({ name: 'show', description: 'Show the latest activity digest.', execute: digest })
  ctx.scheduler.every('recurring-digest', ctx.config.intervalMs, 'digest')
  ctx.lifecycle.add(() => tail.catch(() => {}))
}
