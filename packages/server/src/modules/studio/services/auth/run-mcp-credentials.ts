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
}

type Credential = RunMcpBinding & { tokenFile: string; digest: string }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** In-memory capabilities die with the server and with their owning turn. */
export class RunMcpCredentials {
  private readonly tokens = new Map<string, Credential>()
  private readonly sessions = new Map<string, Map<string, Credential>>()

  async issue(binding: RunMcpBinding, options: { preserveOtherContexts?: boolean } = {}): Promise<string> {
    if (![binding.sessionId, binding.contextId, binding.profile, binding.agentId].every(value => value.trim())) {
      throw new Error('Run MCP credentials require a complete execution context')
    }
    this.revoke(binding.sessionId, options.preserveOtherContexts ? binding.contextId : undefined)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const directory = join(getWebUiHome(), 'runtime', 'mcp-credentials', randomUUID())
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
      contexts.delete(id)
      this.tokens.delete(credential.digest)
      this.removeFile(credential)
    }
    if (!contexts.size) this.sessions.delete(sessionId)
  }

  private removeFile(credential: Credential): void {
    try { unlinkSync(credential.tokenFile) } catch { /* Revocation takes effect in memory even if cleanup fails. */ }
    try { rmdirSync(dirname(credential.tokenFile)) } catch { /* An in-flight write may still need this directory. */ }
  }
}

export const runMcpCredentials = new RunMcpCredentials()
