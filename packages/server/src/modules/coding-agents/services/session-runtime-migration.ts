import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { studioSessionAccount } from '../../studio/contracts/runs/usage'

const pending = new Map<string, Promise<void>>()
const exists = async (path: string) => {
  try { return await lstat(path) } catch (error: any) { if (error.code === 'ENOENT') return null; throw error }
}

/** Copy only the authenticated session's runtime, retaining its old native history. */
export async function migrateSessionRuntime(input: {
  target: string
  candidates: string[]
  accountId: number
  agentSessionId?: string
  session: { studio_user_id?: unknown; user_id?: unknown; source?: string; agent_session_id?: string | null } | null
}): Promise<void> {
  if (!input.session || studioSessionAccount(input.session) !== String(input.accountId)
    || !input.agentSessionId || input.session.agent_session_id !== input.agentSessionId) return
  const running = pending.get(input.target)
  if (running) return running
  const operation = (async () => {
    if (await exists(input.target)) return
    for (const source of input.candidates) {
      if (source === input.target || !(await exists(source))?.isDirectory()) continue
      await mkdir(dirname(input.target), { recursive: true, mode: 0o700 })
      const staging = `${input.target}.migration-${randomUUID()}`
      try {
        await cp(source, staging, { recursive: true, preserveTimestamps: true, dereference: false })
        if (await exists(input.target)) return
        await rename(staging, input.target)
      } finally { await rm(staging, { recursive: true, force: true }) }
      return
    }
  })()
  pending.set(input.target, operation)
  try { await operation } finally { if (pending.get(input.target) === operation) pending.delete(input.target) }
}
