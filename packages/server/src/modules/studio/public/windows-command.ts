import { extname } from 'path'

export interface WindowsCommandExecution {
  command: string
  args: string[]
  windowsVerbatimArguments: true
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g

export function normalizeWindowsCommandPath(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function windowsCommandNeedsShell(command: string): boolean {
  const extension = extname(normalizeWindowsCommandPath(command)).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function escapeCmdCommand(value: string): string {
  return normalizeWindowsCommandPath(value).replace(CMD_META_CHARS, '^$1')
}

function escapeCmdArgument(value: string): string {
  let escaped = String(value)
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1')
  return `"${escaped}"`.replace(CMD_META_CHARS, '^$1')
}

export function buildWindowsCmdShimArgs(command: string, args: string[]): string[] {
  const shellCommand = [
    escapeCmdCommand(command),
    ...args.map(escapeCmdArgument),
  ].join(' ')
  return ['/d', '/s', '/c', `"${shellCommand}"`]
}

export function windowsCmdShimExecution(command: string, args: string[]): WindowsCommandExecution {
  return {
    command: process.env.comspec || 'cmd.exe',
    args: buildWindowsCmdShimArgs(command, args),
    windowsVerbatimArguments: true,
  }
}
