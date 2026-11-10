import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getWebUiHome } from '../../public/config'

const TOKEN_PREFIX = 'studio_run_'

export interface RunMcpBinding {
  sessionId: string
  contextId: string
  profile: string
  roomId?: string
  agentId: string
  /** Only a locally authenticated requester may delegate account permissions. */
  userId?: number
  isActive: () => boolean
  /** Automatic current-session Cron admission only (see `issueCronAdmission`). */
  cron?: CronAdmissionScope
}

/** The frozen scope of one trusted current-session Cron admission authority. */
export interface CronAdmissionScope {
  accountId: number
  generation: string
  epoch: string
  /** A dispatch admits exactly once; a chat turn may admit several jobs while it is live. */
  singleUse: boolean
}

type Credential = RunMcpBinding & { tokenFile: string; digest: string; claimed?: boolean }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** Shared Hermes MCP connections select an interaction-only credential per request. */
export function runMcpContextTokenPath(profile: string, contextId: string): string {
  return join(getWebUiHome(), 'runtime', 'mcp-credentials', `context-${digest(`${profile}\0${contextId}`)}`, 'auth.json')
}

/** In-memory capabilities die with the server and with their owning turn. */
export class RunMcpCredentials {
  private readonly tokens = new Map<string, Credential>()
  private readonly sessions = new Map<string, Map<string, Credential>>()

  async issue(binding: RunMcpBinding, options: { preserveOtherContexts?: boolean; contextLookup?: boolean } = {}): Promise<string> {
    if (![binding.sessionId, binding.contextId, binding.profile, binding.agentId].every(value => value.trim())) {
      throw new Error('Run MCP credentials require a complete execution context')
    }
    if (options.contextLookup && binding.userId !== undefined) {
      throw new Error('Context-selected MCP credentials cannot delegate account permissions')
    }
    this.revoke(binding.sessionId, options.preserveOtherContexts ? binding.contextId : undefined)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const directory = options.contextLookup ? dirname(runMcpContextTokenPath(binding.profile, binding.contextId))
      : join(getWebUiHome(), 'runtime', 'mcp-credentials', randomUUID())
    // Reuse the sensitive basename blocked by local, shared and remote file APIs.
    const credential: Credential = { ...binding, tokenFile: join(directory, 'auth.json'), digest: digest(token) }
    // Register before IO so an abort during preparation can revoke this lease.
    this.tokens.set(credential.digest, credential)
    const contexts = this.sessions.get(binding.sessionId) || new Map<string, Credential>()
    contexts.set(binding.contextId, credential)
    this.sessions.set(binding.sessionId, contexts)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(credential.tokenFile, JSON.stringify({ token, context_id: binding.contextId, profile: binding.profile }), { mode: 0o600, flag: 'wx' })
      if (contexts.get(binding.contextId) !== credential) {
        this.removeFile(credential)
        throw new Error('Run ended while preparing MCP credentials')
      }
      return credential.tokenFile
    } catch (error) {
      if (contexts.get(binding.contextId) === credential) this.revoke(binding.sessionId, binding.contextId)
      else this.removeFile(credential)
      throw error
    }
  }

  /**
   * Memory-only: the token travels as per-call MCP metadata and is never written to disk, so no
   * context file can select it. It is revoked with its execution like any other run credential.
   */
  issueCronAdmission(binding: RunMcpBinding & { cron: CronAdmissionScope }): string {
    if (![binding.sessionId, binding.contextId, binding.profile, binding.cron.generation, binding.cron.epoch].every(value => value.trim())) {
      throw new Error('Cron admission credentials require a complete execution context')
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const credential: Credential = { ...binding, userId: undefined, tokenFile: '', digest: digest(token) }
    this.tokens.set(credential.digest, credential)
    const contexts = this.sessions.get(binding.sessionId) || new Map<string, Credential>()
    contexts.set(binding.contextId, credential)
    this.sessions.set(binding.sessionId, contexts)
    return token
  }

  /** A single-use admission scope admits once; later requests with it are refused. */
  claimCronAdmission(token: string): boolean {
    const credential = this.tokens.get(digest(token))
    if (!credential?.cron) return false
    if (!credential.cron.singleUse) return true
    if (credential.claimed) return false
    credential.claimed = true
    return true
  }

  recognizes(token: string): boolean { return token.startsWith(TOKEN_PREFIX) }

  authenticate(token: string): RunMcpBinding | undefined {
    const credential = this.tokens.get(digest(token))
    if (!credential) return undefined
    if (!credential.isActive()) return undefined
    return credential
  }

  revoke(sessionId: string, contextId?: string): void {
    const contexts = this.sessions.get(sessionId)
    if (!contexts) return
    for (const [id, credential] of contexts) {
      if (contextId && contextId !== id) continue
      // A new turn of the session does not end an independent dispatch; only its own execution does.
      if (!contextId && credential.cron?.singleUse) continue
      contexts.delete(id)
      this.tokens.delete(credential.digest)
      this.removeFile(credential)
    }
    if (!contexts.size) this.sessions.delete(sessionId)
  }

  private removeFile(credential: Credential): void {
    if (!credential.tokenFile) return
    try { unlinkSync(credential.tokenFile) } catch { /* Revocation takes effect in memory even if cleanup fails. */ }
    try { rmdirSync(dirname(credential.tokenFile)) } catch { /* An in-flight write may still need this directory. */ }
  }
}

export const runMcpCredentials = new RunMcpCredentials()
