import type { ChildProcess } from 'node:child_process'

export interface OpenCodeTurnHost {
  spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess
  isRunning(child?: ChildProcess): boolean
  processError(error: unknown): string
  exitError(code: number | null, stderr?: string): string
  errorMessage(error: unknown): string
  sanitizeOutput(text: string): string
  appendedTextDelta(existing: string, next: string): string
  truncateToolOutput(output: unknown): string
  touch(): void
  line(line: string): void
  stderr(chunk: Buffer): string
  response(event: any): void
  ensureText(): void
  completeAfterUsage(event: any, payload: any): Promise<void>
  complete(): void
  fail(message: string): void
}
