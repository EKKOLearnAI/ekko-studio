import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const OUTPUT_TAIL_LENGTH = 8_192
const LOG_TAIL_LENGTH = 65_536

export class WebUiStartupDiagnostics {
  private stdout = ''
  private stderr = ''
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')

  constructor(private readonly logFile: string, private readonly context: string) {}

  observeStdout(chunk: Buffer): void {
    this.stdout = (this.stdout + this.stdoutDecoder.write(chunk)).slice(-OUTPUT_TAIL_LENGTH)
  }

  observeStderr(chunk: Buffer): void {
    this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-OUTPUT_TAIL_LENGTH)
  }

  failure(reason: unknown): Error {
    this.stdout = (this.stdout + this.stdoutDecoder.end()).slice(-OUTPUT_TAIL_LENGTH)
    this.stderr = (this.stderr + this.stderrDecoder.end()).slice(-OUTPUT_TAIL_LENGTH)
    const message = reason instanceof Error ? reason.message : String(reason)
    const output = [
      this.stdout.trim() && `stdout:\n${this.stdout.trim()}`,
      this.stderr.trim() && `stderr:\n${this.stderr.trim()}`,
    ].filter(Boolean).join('\n\n')
    const detail = [message, output].filter(Boolean).join('\n\n')

    try {
      mkdirSync(dirname(this.logFile), { recursive: true })
      let previous = ''
      try {
        if (statSync(this.logFile).size <= LOG_TAIL_LENGTH * 4) {
          previous = readFileSync(this.logFile, 'utf8')
        }
      } catch { /* first failure */ }
      const record = `\n[${new Date().toISOString()}]\n${this.context}\n${detail}\n`
      // Preserve both the active and bundled Web UI failures, with bounded history.
      writeFileSync(this.logFile, (previous + record).slice(-LOG_TAIL_LENGTH), { mode: 0o600 })
      return new Error(`${detail}\n\nStartup log: ${this.logFile}`, { cause: reason })
    } catch (error) {
      // Diagnostic IO must not hide the original server failure.
      const logError = error instanceof Error ? error.message : String(error)
      return new Error(`${detail}\n\nUnable to write startup log: ${logError}`, { cause: reason })
    }
  }
}
