import type { ChildProcess } from 'node:child_process'
import type { AcpEventHost } from '../../protocol/acp/events'

export interface NativeTurnHost extends AcpEventHost {
  spawn(command: string, args: string[], options: { cwd: string; pipeStdin: boolean; env: NodeJS.ProcessEnv }): ChildProcess
  isRunning(child?: ChildProcess): boolean
  terminate(child?: ChildProcess): void
  forceKill(child?: ChildProcess): void
  processError(error: unknown): string
  exitError(code: number | null, stderr?: string): string
  stderr(chunk: Buffer): void
  touch(): void
  response(event: any): void
  completeAfterUsage(event: any, payload: any): Promise<void>
  complete(usage?: any): void
  fail(message: string): void
}
