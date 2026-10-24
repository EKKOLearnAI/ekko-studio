import { isAbsolute } from 'node:path'
import { NativeRpcConnection } from '@ekko-studio/agent-drivers'
import { StudioError, type AgentInspection, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

export const management: AgentManagementAdapter = {
  async inspect({ config, mode }, context) {
    if (mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    const cwd = String(config.cwd)
    if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Codex working directory must be absolute')
    const process = await context.processes.spawn({ command: String(config.command || 'codex'),
      args: [...(config.args as string[] || []), 'app-server', '--listen', 'stdio://'], cwd, env: config.env as Record<string, string> | undefined })
    const rpc = new NativeRpcConnection(process, { notification() {} })
    const abort = () => { void rpc.close().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      await rpc.start()
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      await rpc.request('initialize', { clientInfo: { name: 'ekko_studio', title: 'Ekko Studio', version: '0.1.0' } })
      await rpc.notify('initialized')
      const account = await rpc.request('account/read', { refreshToken: false })
      if (!account || typeof account.requiresOpenaiAuth !== 'boolean' || (account.account !== null && typeof account.account?.type !== 'string')) throw new Error('Invalid Codex account response')
      const state = account.account === null ? (account.requiresOpenaiAuth ? 'required' : 'not_required')
        : ['apiKey', 'chatgpt', 'amazonBedrock'].includes(account.account.type) ? 'authenticated' : 'unknown'
      const items: AgentInspection['models']['items'] = [], cursors = new Set<string>()
      let cursor: string | null = null, count = 0
      do {
        const page = await rpc.request('model/list', { limit: 64, cursor, includeHidden: false })
        if (!page || !Array.isArray(page.data) || (count += page.data.length) > 512
          || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096))) throw new Error('Invalid Codex model page')
        for (const model of page.data) {
          if (!model || typeof model.hidden !== 'boolean' || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 32) throw new Error('Invalid Codex model')
          if (!model.hidden) items.push({ id: model.model, name: model.displayName, isDefault: model.isDefault,
            reasoningEfforts: model.supportedReasoningEfforts.map((option: any) => option.reasoningEffort) })
        }
        cursor = page.nextCursor
        if (cursor !== null) {
          if (cursors.has(cursor) || cursors.size >= 16) throw new Error('Codex model cursor did not advance')
          cursors.add(cursor)
        }
      } while (cursor !== null)
      return { native: { name: 'Codex' }, authentication: { state, methods: [] }, models: { status: 'available', items } }
    } finally { context.signal.removeEventListener('abort', abort); await rpc.close() }
  },
}
