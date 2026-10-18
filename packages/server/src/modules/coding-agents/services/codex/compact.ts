import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import {
  normalizeWindowsCommandPath,
  windowsCmdShimExecution,
  windowsCommandNeedsShell,
} from '../../../studio/public/windows-command'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'

const APP_SERVER_READY_TIMEOUT_MS = 30_000
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000

export interface CodexCompactLaunch {
  command: string
  env: NodeJS.ProcessEnv
  workspaceDir?: string
}

interface JsonRpcMessage {
  id?: number
  method?: string
  result?: unknown
  error?: { code?: number; message?: string }
  params?: any
}

export async function compactCodexThread(
  launch: CodexCompactLaunch,
  threadId: string,
  options: { timeoutMs?: number } = {},
): Promise<{ compacted: boolean; beforeTokens?: number | null; afterTokens?: number | null }> {
  const cwd = launch.workspaceDir && existsSync(launch.workspaceDir) ? launch.workspaceDir : homedir()
  const command = process.platform === 'win32' ? normalizeWindowsCommandPath(launch.command) : launch.command
  const appArgs = ['app-server', '--stdio']
  const execution = process.platform === 'win32' && windowsCommandNeedsShell(launch.command)
    ? windowsCmdShimExecution(command, appArgs)
    : { command, args: appArgs }

  const child: ChildProcess = spawn(execution.command, execution.args, {
    cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: (execution as any).windowsVerbatimArguments === true,
    windowsHide: true,
  })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let resumeAccepted = false
    let compactAccepted = false
    let compactCompleted = false
    let settled = false
    let compactError: string | null = null
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    let compactTimer: ReturnType<typeof setTimeout> | null = null
    let beforeTokens: number | null = null
    let afterTokens: number | null = null
    let latestTokens: number | null = null

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (readyTimer) clearTimeout(readyTimer)
      if (compactTimer) clearTimeout(compactTimer)
      try {
        terminateCodexChild(child)
      } catch {}
      fn()
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message: JsonRpcMessage
      try {
        message = JSON.parse(trimmed)
      } catch {
        return
      }

      if (message.method === 'thread/compacted' && String(message.params?.threadId || '') === threadId) {
        compactCompleted = true
        settle(() => resolve({ compacted: true, beforeTokens, afterTokens }))
        return
      }

      if (
        message.method === 'turn/completed' &&
        compactAccepted &&
        String(message.params?.threadId || '') === threadId
      ) {
        compactCompleted = true
        settle(() => resolve({ compacted: true, beforeTokens, afterTokens }))
        return
      }

      if (message.method === 'thread/tokenUsage/updated' && String(message.params?.threadId || '') === threadId) {
        const last = message.params?.tokenUsage?.last
        const totalTokens = typeof last?.totalTokens === 'number' && Number.isFinite(last.totalTokens)
          ? Math.floor(last.totalTokens)
          : null
        if (totalTokens != null) {
          latestTokens = totalTokens
          if (compactAccepted) {
            if (beforeTokens == null) beforeTokens = totalTokens
            afterTokens = totalTokens
          }
        }
        return
      }

      if (message.id === 0 && message.result !== undefined && !compactAccepted) {
        child.stdin?.write('{"jsonrpc":"2.0","method":"initialized"}\n')
        child.stdin?.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'thread/resume',
          params: { threadId },
        }) + '\n')
        return
      }

      if (message.id === 1 && !resumeAccepted) {
        resumeAccepted = true
        if (message.error) {
          compactError = message.error.message || `Codex app-server error ${message.error.code || ''}`.trim()
          settle(() => reject(new Error(compactError || 'Codex thread resume failed')))
          return
        }
        child.stdin?.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'thread/compact/start',
          params: { threadId },
        }) + '\n')
        return
      }

      if (message.id === 2 && !compactAccepted) {
        compactAccepted = true
        if (message.error) {
          compactError = message.error.message || `Codex app-server error ${message.error.code || ''}`.trim()
          settle(() => reject(new Error(compactError || 'Codex compaction failed')))
          return
        }
        if (beforeTokens == null && latestTokens != null) beforeTokens = latestTokens
        if (readyTimer) clearTimeout(readyTimer)
        readyTimer = null
        compactTimer = setTimeout(() => {
          settle(() => reject(new Error('Codex compaction timed out after 5 minutes')))
        }, options.timeoutMs || COMPACT_TIMEOUT_MS)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() || ''
      for (const line of lines) handleLine(line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      settle(() => reject(new Error(`Failed to start Codex app-server: ${err.message}`)))
    })

    child.on('close', (code) => {
      if (settled) return
      const message = compactError || (compactAccepted && !compactCompleted
        ? `Codex app-server exited before compaction completed (${code ?? 'unknown'})${stderr ? `\n${stderr.slice(-2_000)}` : ''}`
        : `Codex app-server exited (${code ?? 'unknown'})${stderr ? `\n${stderr.slice(-2_000)}` : ''}`)
      settle(() => reject(new Error(message)))
    })

    child.stdin?.on('error', (err) => {
      settle(() => reject(new Error(`Codex app-server stdin failed: ${err.message}`)))
    })

    const clientInfo = {
      name: 'hermes_studio',
      title: 'Ekko Studio',
      version: '0.6.43',
    }
    child.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { clientInfo },
    }) + '\n')

    readyTimer = setTimeout(() => {
      settle(() => reject(new Error('Codex app-server did not become ready in time')))
    }, APP_SERVER_READY_TIMEOUT_MS)
  })
}

function terminateCodexChild(child: ChildProcess) {
  if (!child || child.killed || !child.pid) return
  if (process.platform === 'win32') {
    try { killOwnedProcessTree(child.pid, () => { child.kill() }) } catch {}
    return
  }
  try {
    child.kill()
  } catch {}
}
