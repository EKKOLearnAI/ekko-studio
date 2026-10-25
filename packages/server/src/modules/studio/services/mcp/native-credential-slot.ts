import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError } from '../../contracts/plugins'
import { getWebUiHome } from '../../public/config'
import { leaseStudioMcpServers } from './credential-lease'
import { isStudioManagedMcpServer } from './managed-config'

type Run = Parameters<typeof leaseStudioMcpServers>[1]
type Lease = Awaited<ReturnType<typeof leaseStudioMcpServers>>
interface ActiveSlot { dispose(): Promise<void> }

/** Native MCP processes may cache their launch config across turns. The launcher
 * rereads this private path on each request, while each credential still belongs
 * to exactly one Run. Admission and cleanup are serialized, including file IO. */
export class NativeMcpCredentialSlot {
  private readonly directory = join(getWebUiHome(), 'runtime', 'mcp-credentials', `native-${randomUUID()}`)
  private readonly file = join(this.directory, 'auth.json')
  private active?: ActiveSlot
  private closed = false

  async begin(servers: Record<string, unknown>, run: Run): Promise<{ servers: Record<string, unknown>; contextId?: string; dispose(): Promise<void> }> {
    if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Native MCP runtime has ended')
    if (this.active) throw new StudioError('REVISION_CONFLICT', 'Native MCP runtime still owns a turn credential')
    if (run.signal.aborted) throw new StudioError('CANCELLED', 'Native MCP turn ended')
    run = { ...run }
    const controller = new AbortController(), signal = AbortSignal.any([run.signal, controller.signal])
    let source: Lease | undefined, cleanup: Promise<void> | undefined
    const preparing = Promise.resolve().then(async () => {
      source = await leaseStudioMcpServers(servers, { ...run, signal })
      signal.throwIfAborted()
      const credentialFiles = new Set(Object.entries(source.servers || {}).filter(([name, value]) => isStudioManagedMcpServer(name, value)).map(([, value]) => {
        const env = (value as { env?: Record<string, string> } | null)?.env
        return env?.HERMES_WEB_UI_RUN_TOKEN_FILE
      }).filter((value): value is string => !!value))
      if (!credentialFiles.size) return source.servers || {}
      if (credentialFiles.size !== 1) throw new StudioError('INVALID_ARGUMENT', 'Native MCP servers must share their turn credential')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      await copyFile([...credentialFiles][0], this.file, constants.COPYFILE_EXCL)
      signal.throwIfAborted()
      return Object.fromEntries(Object.entries(source.servers || {}).map(([name, value]) => {
        const server = value as { env?: Record<string, string> }
        return [name, isStudioManagedMcpServer(name, value) && server?.env?.HERMES_WEB_UI_RUN_TOKEN_FILE ? {
          ...server, env: { ...server.env, HERMES_WEB_UI_RUN_TOKEN_FILE: this.file, HERMES_MCP_RUN_BOUND_CONTEXT: '1' },
        } : server]
      }))
    })
    const dispose = (): Promise<void> => cleanup ??= (async () => {
      controller.abort()
      run.signal.removeEventListener('abort', aborted)
      await preparing.catch(() => {})
      source?.dispose()
      try { await rm(this.directory, { recursive: true, force: true }) }
      finally { if (this.active === active) this.active = undefined }
    })()
    const active = { dispose }, aborted = () => { void dispose().catch(() => {}) }
    this.active = active
    run.signal.addEventListener('abort', aborted, { once: true })
    if (run.signal.aborted) aborted()
    try { const configured = await preparing; return { servers: configured, contextId: source?.contextId, dispose } }
    catch {
      await dispose()
      if (run.signal.aborted) throw new StudioError('CANCELLED', 'Native MCP turn ended')
      throw new StudioError('RUNTIME_UNAVAILABLE', 'Native MCP credential preparation failed')
    }
  }

  async close(): Promise<void> { this.closed = true; await this.active?.dispose() }
}
