import { getLanPeerSocketManager, type LanPeerExecResult, type LanPeerTerminalInfo, type LanPeerTerminalList, type LanPeerTerminalReadResult } from './lan-peer-socket'
import { readFile, writeFile } from 'fs/promises'
import { validatePath } from '../files/file-provider'

export type PeerToolUploadInput = {
  connectionId: string
  localPath: string
  remotePath: string
  timeoutMs?: number
}

export type PeerToolDownloadInput = {
  connectionId: string
  remotePath: string
  localPath: string
  timeoutMs?: number
}

export type PeerToolExecInput = {
  connectionId: string
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export type PeerToolTerminalInput = {
  connectionId: string
  terminalId: string
}

export class LanPeerToolsService {
  listConnections() {
    return getLanPeerSocketManager().listConnections()
  }

  disconnect(connectionId: string): boolean {
    return getLanPeerSocketManager().disconnect(connectionId)
  }

  async createTerminal(connectionId: string, options: { shell?: string; cols?: number; rows?: number } = {}): Promise<LanPeerTerminalInfo> {
    return this.requireClientConnection(connectionId).createRemoteTerminal(options)
  }

  listTerminals(connectionId: string): LanPeerTerminalList {
    return this.requireClientConnection(connectionId).listTerminals()
  }

  writeTerminal(input: PeerToolTerminalInput & { data: string }) {
    this.requireClientConnection(input.connectionId).writeRemoteTerminal(input.terminalId, input.data)
    return { ok: true }
  }

  resizeTerminal(input: PeerToolTerminalInput & { cols: number; rows: number }) {
    this.requireClientConnection(input.connectionId).resizeRemoteTerminal(input.terminalId, input.cols, input.rows)
    return { ok: true }
  }

  closeTerminal(input: PeerToolTerminalInput) {
    this.requireClientConnection(input.connectionId).closeRemoteTerminal(input.terminalId)
    return { ok: true }
  }

  readTerminal(input: PeerToolTerminalInput): LanPeerTerminalReadResult {
    return this.requireClientConnection(input.connectionId).readRemoteTerminal(input.terminalId)
  }

  exec(input: PeerToolExecInput): Promise<LanPeerExecResult> {
    return this.requireClientConnection(input.connectionId).execRemoteCommand({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    })
  }

  async downloadFile(input: PeerToolDownloadInput) {
    const localPath = validatePath(input.localPath)
    const data = await this.requireClientConnection(input.connectionId).downloadFileToBuffer(input.remotePath, input.timeoutMs)
    await writeFile(localPath, data)
    return {
      remote_path: input.remotePath,
      local_path: localPath,
      size: data.length,
    }
  }

  async uploadFile(input: PeerToolUploadInput) {
    const localPath = validatePath(input.localPath)
    const data = await readFile(localPath)
    const result = await this.requireClientConnection(input.connectionId).uploadFileFromBuffer(
      input.remotePath,
      data,
      input.timeoutMs,
    )
    return {
      ...result,
      local_path: localPath,
      remote_path: input.remotePath,
    }
  }

  private requireConnection(connectionId: string) {
    const connection = getLanPeerSocketManager().getConnection(connectionId)
    if (!connection) throw Object.assign(new Error('Peer connection not found'), { status: 404 })
    return connection
  }

  private requireClientConnection(connectionId: string) {
    const connection = this.requireConnection(connectionId)
    if (connection.info().role !== 'client') {
      throw Object.assign(new Error('Peer connection is not authorized for remote tools'), { status: 403 })
    }
    return connection
  }
}

let singleton: LanPeerToolsService | null = null

export function getLanPeerToolsService(): LanPeerToolsService {
  if (!singleton) singleton = new LanPeerToolsService()
  return singleton
}
