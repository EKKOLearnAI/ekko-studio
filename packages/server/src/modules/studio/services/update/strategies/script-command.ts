import * as childProcess from 'child_process'
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { UpdateError } from '../errors'

export interface ScriptExecutionCommand {
  command: string
  args: string[]
}

export type CommandResolver = (command: string) => string | undefined

function resolveExecutable(command: string): string | undefined {
  const trimmed = command.trim()
  if (!trimmed) return undefined

  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return existsSync(trimmed) ? resolve(trimmed) : undefined
  }

  try {
    const lookup = process.platform === 'win32'
      ? childProcess.execFileSync('where.exe', [trimmed], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
      : childProcess.execFileSync('which', [trimmed], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
    return lookup.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

export function buildShellScriptCommand(
  script: string,
  args: string[],
  scriptLabel: string,
  resolveCommand: CommandResolver = resolveExecutable,
): ScriptExecutionCommand {
  const bash = resolveCommand('bash')
    || resolveCommand('bash.exe')
    || resolveCommand('/bin/bash')
  if (!bash) {
    throw new UpdateError(
      'update_execution_misconfigured',
      `${scriptLabel} requires bash, but no bash executable was found in PATH.`,
    )
  }

  return {
    command: bash,
    args: [script, ...args],
  }
}
