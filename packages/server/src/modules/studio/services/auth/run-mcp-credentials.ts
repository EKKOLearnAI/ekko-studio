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
  roomId: string
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
  private readonly sessions = new Map<string, Credential>()

  async issue(binding: RunMcpBinding): Promise<string> {
    if (![binding.sessionId, binding.contextId, binding.profile, binding.roomId, binding.agentId].every(value => value.trim())) {
      throw new Error('Group MCP credentials require a complete execution context')
    }
    this.revoke(binding.sessionId)
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const directory = join(getWebUiHome(), 'runtime', 'mcp-credentials', randomUUID())
    // Reuse the sensitive basename blocked by local, shared and remote file APIs.
    const credential: Credential = { ...binding, tokenFile: join(directory, 'auth.json'), digest: digest(token) }
    // Register before IO so an abort during preparation can revoke this lease.
    this.tokens.set(credential.digest, credential)
    this.sessions.set(binding.sessionId, credential)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(credential.tokenFile, JSON.stringify({ token, context_id: binding.contextId, profile: binding.profile }), { mode: 0o600, flag: 'wx' })
      if (this.sessions.get(binding.sessionId) !== credential) {
        this.removeFile(credential)
        throw new Error('Group run ended while preparing MCP credentials')
      }
      return credential.tokenFile
    } catch (error) {
      if (this.sessions.get(binding.sessionId) === credential) this.revoke(binding.sessionId)
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
    const credential = this.sessions.get(sessionId)
    if (!credential || (contextId && contextId !== credential.contextId)) return
    this.sessions.delete(sessionId)
    this.tokens.delete(credential.digest)
    this.removeFile(credential)
  }

  private removeFile(credential: Credential): void {
    try { unlinkSync(credential.tokenFile) } catch { /* Revocation takes effect in memory even if cleanup fails. */ }
    try { rmdirSync(dirname(credential.tokenFile)) } catch { /* An in-flight write may still need this directory. */ }
  }
}

export const runMcpCredentials = new RunMcpCredentials()
