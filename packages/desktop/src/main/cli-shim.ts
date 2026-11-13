import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { HERMES_CLI_ARG } from './cli-constants'

const execFileAsync = promisify(execFile)

const SHIM_MARKER = 'HERMES_STUDIO_CLI_SHIM'
const MCP_SHIM_MARKER = 'HERMES_STUDIO_MCP_SHIM'
const PATH_MARKER_START = '# >>> Hermes Studio CLI shim >>>'
const PATH_MARKER_END = '# <<< Hermes Studio CLI shim <<<'
const WINDOWS_USER_PATH_ENV_B64 = 'HERMES_STUDIO_WINDOWS_USER_PATH_B64'

type ShimInstallStatus = 'installed' | 'updated' | 'unchanged' | 'skipped'

export interface CliShimInstallResult {
  shimPath: string
  status: ShimInstallStatus
  pathUpdated: boolean
  reason?: string
}

interface CliShimInstallOptions {
  env?: NodeJS.ProcessEnv
  executablePath?: string
  homeDir?: string
  nodePath?: string
  platform?: NodeJS.Platform
  runtimeVersion?: string
  webUiScriptPath?: string
}

interface McpShimInstallOptions extends CliShimInstallOptions {
  nodePath?: string
  scriptPath?: string
  webUiUrl?: string
}

function platformDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' ? win32.resolve(value) : posix.resolve(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function pathContainsDir(pathValue: string | undefined, binDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!pathValue) return false
  const target = pathKey(binDir, platform)
  return pathValue
    .split(platformDelimiter(platform))
    .map(entry => entry.trim())
    .filter(Boolean)
    .some(entry => pathKey(entry, platform) === target)
}

function executableForShim(options: Required<Pick<CliShimInstallOptions, 'env' | 'executablePath' | 'platform'>>): string {
  const appImage = options.platform === 'linux' ? options.env.APPIMAGE?.trim() : ''
  return appImage || options.executablePath
}

export function shimPathForPlatform(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, platform === 'win32' ? 'ekko-studio.cmd' : 'ekko-studio')
}

export function mcpShimPathForPlatform(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, platform === 'win32' ? 'ekko-studio-mcp.cmd' : 'ekko-studio-mcp')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function windowsRuntimePlatformKey(archName: string): string {
  return `win-${archName}`
}

function jsSingleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function windowsCliForwarder(runtimePlatform: string, runtimeVersion: string): string {
  const platform = jsSingleQuoted(runtimePlatform)
  const version = jsSingleQuoted(runtimeVersion)
  return [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const cp=require('node:child_process')",
    'const args=process.argv.slice(1)',
    "const webUiHome=process.env.HERMES_WEB_UI_HOME||process.env.HERMES_WEBUI_STATE_DIR||path.join(process.env.USERPROFILE||'','.hermes-web-ui')",
    "let runtime=(process.env.HERMES_DESKTOP_RUNTIME_DIR||'').trim()",
    `if(!runtime){try{const active=JSON.parse(fs.readFileSync(path.join(webUiHome,'desktop-runtime','active-version.json'),'utf8'));if(active.platform===${platform}&&typeof active.runtimeDirectory==='string'&&active.runtimeDirectory.trim()&&fs.existsSync(active.runtimeDirectory))runtime=active.runtimeDirectory.trim()}catch{}}`,
    `if(!runtime)runtime=path.join(webUiHome,'desktop-runtime','hermes',${version},${platform})`,
    "let virtualEnv=path.join(runtime,'python','venv')",
    "let python=path.join(virtualEnv,'Scripts','python.exe')",
    "if(!fs.existsSync(python))python=path.join(virtualEnv,'python.exe')",
    "if(!fs.existsSync(python)){virtualEnv=path.join(runtime,'python');python=path.join(virtualEnv,'python.exe')}",
    "if(!fs.existsSync(python)){console.error('Ekko Studio Python runtime not found at '+python);console.error('Open Ekko Studio once to finish runtime setup, then retry ekko-studio cli.');process.exit(127)}",
    "const inheritedPath=process.env.PATH||process.env.Path||''",
    'const env={...process.env,VIRTUAL_ENV:virtualEnv,UV_PROJECT_ENVIRONMENT:virtualEnv,UV_PYTHON:python,HERMES_AGENT_ROOT:path.join(runtime,\'python\'),HERMES_AGENT_NODE:path.join(runtime,\'node\',\'node.exe\'),HERMES_AGENT_NODE_ROOT:path.join(runtime,\'node\'),AGENT_BROWSER_HOME:path.join(runtime,\'python\',\'agent-browser\'),PLAYWRIGHT_BROWSERS_PATH:path.join(runtime,\'python\',\'ms-playwright\')}',
    "for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key]",
    "env.PATH=[path.join(runtime,'python','venv','Scripts'),path.join(runtime,'python','node'),path.join(runtime,'node'),path.join(runtime,'git','cmd'),inheritedPath].filter(Boolean).join(';')",
    "const result=cp.spawnSync(python,['-m','hermes_cli.main',...args],{stdio:'inherit',windowsHide:true,env})",
    'if(result.error){console.error(result.error.message);process.exit(127)}',
    'process.exit(result.status===null?(result.signal?1:0):result.status)',
  ].join(';')
}

function utf8Base64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

function powershellUtf8Value(value: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${utf8Base64(value)}'))`
}

function windowsPowerShellSidecarName(name: 'ekko-studio' | 'ekko-studio-mcp'): string {
  return `${name}.ps1`
}

function windowsCmdShimContent(name: 'ekko-studio' | 'ekko-studio-mcp', marker: string): string {
  return [
    '@echo off',
    `rem ${marker}`,
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${windowsPowerShellSidecarName(name)}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

export function createPowerShellShimContent(
  executablePath: string,
  archName: string = process.arch,
  runtimeVersion = '0.20.0',
  nodePath = process.execPath,
  webUiScriptPath = resolve(process.cwd(), 'bin', 'hermes-web-ui.mjs'),
): string {
  const cliForwarder = windowsCliForwarder(windowsRuntimePlatformKey(archName), runtimeVersion)
  return [
    `# ${SHIM_MARKER}`,
    `$App = ${powershellUtf8Value(executablePath)}`,
    `$Node = ${powershellUtf8Value(nodePath)}`,
    `$WebUiScript = ${powershellUtf8Value(webUiScriptPath)}`,
    `$CliForwarder = ${powershellUtf8Value(cliForwarder)}`,
    '$CommandArgs = @($args)',
    "$Command = if ($CommandArgs.Count -gt 0) { [string]$CommandArgs[0] } else { '' }",
    '[string[]]$ForwardArgs = @()',
    'if ($CommandArgs.Count -gt 1) {',
    '  $ForwardArgs = [string[]]$CommandArgs[1..($CommandArgs.Count - 1)]',
    '}',
    'function Show-HermesStudioHelp {',
    "  [Console]::Out.WriteLine('Usage: ekko-studio [command] [options]')",
    "  [Console]::Out.WriteLine('')",
    "  [Console]::Out.WriteLine('Commands:')",
    "  [Console]::Out.WriteLine('  (no command)       Open Ekko Studio desktop app')",
    "  [Console]::Out.WriteLine('  cli [args...]      Run bundled Hermes Agent CLI')",
    "  [Console]::Out.WriteLine('  web [args...]      Run bundled hermes-web-ui command')",
    "  [Console]::Out.WriteLine('  help, -h, --help   Show this help message')",
    '}',
    "switch ($Command.ToLowerInvariant()) {",
    "  '' {",
    '    if (!(Test-Path -LiteralPath $App -PathType Leaf)) {',
    "      [Console]::Error.WriteLine('Ekko Studio executable not found at ' + $App)",
    '      exit 127',
    '    }',
    '    Start-Process -FilePath $App',
    '    exit 0',
    '  }',
    "  'help' { Show-HermesStudioHelp; exit 0 }",
    "  '-h' { Show-HermesStudioHelp; exit 0 }",
    "  '--help' { Show-HermesStudioHelp; exit 0 }",
    "  'cli' {",
    '    if (!(Test-Path -LiteralPath $Node -PathType Leaf)) {',
    "      [Console]::Error.WriteLine('Ekko Studio Node runtime not found at ' + $Node)",
    "      [Console]::Error.WriteLine('Open Ekko Studio once to finish runtime setup, then retry ekko-studio cli.')",
    '      exit 127',
    '    }',
    '    & $Node -e $CliForwarder @ForwardArgs',
    '    exit $LASTEXITCODE',
    '  }',
    "  'web' {",
    '    if (!(Test-Path -LiteralPath $Node -PathType Leaf)) {',
    "      [Console]::Error.WriteLine('Ekko Studio Node runtime not found at ' + $Node)",
    "      [Console]::Error.WriteLine('Open Ekko Studio once to finish runtime setup, then retry ekko-studio web.')",
    '      exit 127',
    '    }',
    '    if (!(Test-Path -LiteralPath $WebUiScript -PathType Leaf)) {',
    "      [Console]::Error.WriteLine('Hermes Web UI script not found at ' + $WebUiScript)",
    '      exit 127',
    '    }',
    '    & $Node $WebUiScript @ForwardArgs',
    '    exit $LASTEXITCODE',
    '  }',
    '  default {',
    "    [Console]::Error.WriteLine('Unknown Ekko Studio command: ' + $Command)",
    "    [Console]::Error.WriteLine('Run ekko-studio --help for usage.')",
    '    exit 2',
    '  }',
    '}',
    '',
  ].join('\r\n')
}

export function createShimContent(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
  archName: string = process.arch,
  runtimeVersion = '0.20.0',
  nodePath = process.execPath,
  webUiScriptPath = resolve(process.cwd(), 'bin', 'hermes-web-ui.mjs'),
): string {
  if (platform === 'win32') {
    return windowsCmdShimContent('ekko-studio', SHIM_MARKER)
  }

  return [
    '#!/bin/sh',
    `# ${SHIM_MARKER}`,
    `APP=${shellQuote(executablePath)}`,
    `NODE=${shellQuote(nodePath)}`,
    `WEBUI_SCRIPT=${shellQuote(webUiScriptPath)}`,
    'show_help() {',
    '  cat <<\'EOF\'',
    'Usage: ekko-studio [command] [options]',
    '',
    'Commands:',
    '  (no command)       Open Ekko Studio desktop app',
    '  cli [args...]      Run bundled Hermes Agent CLI',
    '  web [args...]      Run bundled hermes-web-ui command',
    '  help, -h, --help   Show this help message',
    'EOF',
    '}',
    'if [ ! -x "$APP" ]; then',
    '  echo "Ekko Studio executable not found at $APP" >&2',
    '  exit 127',
    'fi',
    'unset ELECTRON_RUN_AS_NODE',
    'case "${1:-}" in',
    '  "")',
    '    exec "$APP"',
    '    ;;',
    '  cli)',
    '    shift',
    `    exec "$APP" -- ${HERMES_CLI_ARG} "$@"`,
    '    ;;',
    '  web)',
    '    shift',
    '    if [ ! -x "$NODE" ]; then',
    '      echo "Ekko Studio Node runtime not found at $NODE" >&2',
    '      echo "Open Ekko Studio once to finish runtime setup, then retry ekko-studio web." >&2',
    '      exit 127',
    '    fi',
    '    if [ ! -f "$WEBUI_SCRIPT" ]; then',
    '      echo "Hermes Web UI script not found at $WEBUI_SCRIPT" >&2',
    '      exit 127',
    '    fi',
    '    exec "$NODE" "$WEBUI_SCRIPT" "$@"',
    '    ;;',
    '  help|-h|--help)',
    '    show_help',
    '    exit 0',
    '    ;;',
    '  *)',
    '    echo "Unknown Ekko Studio command: $1" >&2',
    '    echo "Run ekko-studio --help for usage." >&2',
    '    exit 2',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

export function createMcpShimContent(
  nodePath: string,
  scriptPath: string,
  webUiUrl = 'http://127.0.0.1:8748',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return windowsCmdShimContent('ekko-studio-mcp', MCP_SHIM_MARKER)
  }

  return [
    '#!/bin/sh',
    `# ${MCP_SHIM_MARKER}`,
    `NODE=${shellQuote(nodePath)}`,
    `SCRIPT=${shellQuote(scriptPath)}`,
    'if [ ! -x "$NODE" ]; then',
    '  echo "Ekko Studio Node runtime not found at $NODE" >&2',
    '  echo "Open Ekko Studio once to finish runtime setup, then retry ekko-studio-mcp." >&2',
    '  exit 127',
    'fi',
    'if [ ! -f "$SCRIPT" ]; then',
    '  echo "Ekko Studio MCP script not found at $SCRIPT" >&2',
    '  exit 127',
    'fi',
    'if [ -z "${HERMES_WEB_UI_URL:-}" ]; then',
    '  if [ -n "${HERMES_DESKTOP_PORT:-}" ]; then',
    '    HERMES_WEB_UI_URL="http://127.0.0.1:${HERMES_DESKTOP_PORT}"',
    '  else',
    `    HERMES_WEB_UI_URL=${shellQuote(webUiUrl)}`,
    '  fi',
    'fi',
    'export HERMES_WEB_UI_URL',
    'if [ -z "${HERMES_MCP_SERVER_NAME:-}" ]; then',
    '  HERMES_MCP_SERVER_NAME=ekko-studio-mcp',
    'fi',
    'export HERMES_MCP_SERVER_NAME',
    'exec "$NODE" "$SCRIPT" "$@"',
    '',
  ].join('\n')
}

export function createMcpPowerShellShimContent(
  nodePath: string,
  scriptPath: string,
  webUiUrl = 'http://127.0.0.1:8748',
): string {
  return [
    `# ${MCP_SHIM_MARKER}`,
    `$Node = ${powershellUtf8Value(nodePath)}`,
    `$Script = ${powershellUtf8Value(scriptPath)}`,
    `$DefaultWebUiUrl = ${powershellUtf8Value(webUiUrl)}`,
    'if (!(Test-Path -LiteralPath $Node -PathType Leaf)) {',
    "  [Console]::Error.WriteLine('Ekko Studio Node runtime not found at ' + $Node)",
    "  [Console]::Error.WriteLine('Open Ekko Studio once to finish runtime setup, then retry ekko-studio-mcp.')",
    '  exit 127',
    '}',
    'if (!(Test-Path -LiteralPath $Script -PathType Leaf)) {',
    "  [Console]::Error.WriteLine('Ekko Studio MCP script not found at ' + $Script)",
    '  exit 127',
    '}',
    "if ([string]::IsNullOrWhiteSpace($env:HERMES_WEB_UI_URL)) {",
    "  if ([string]::IsNullOrWhiteSpace($env:HERMES_DESKTOP_PORT)) {",
    '    $env:HERMES_WEB_UI_URL = $DefaultWebUiUrl',
    '  } else {',
    "    $env:HERMES_WEB_UI_URL = 'http://127.0.0.1:' + $env:HERMES_DESKTOP_PORT",
    '  }',
    '}',
    "if ([string]::IsNullOrWhiteSpace($env:HERMES_MCP_SERVER_NAME)) {",
    "  $env:HERMES_MCP_SERVER_NAME = 'ekko-studio-mcp'",
    '}',
    '& $Node $Script @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

function isManagedShim(content: string, marker: string): boolean {
  return content.includes(marker)
}

function writeShim(shimPath: string, content: string, platform: NodeJS.Platform, marker = SHIM_MARKER): ShimInstallStatus {
  if (existsSync(shimPath)) {
    const existing = readFileSync(shimPath, 'utf-8')
    if (existing === content) return 'unchanged'
    if (!isManagedShim(existing, marker)) return 'skipped'
    writeFileSync(shimPath, content, 'utf-8')
    if (platform !== 'win32') chmodSync(shimPath, 0o755)
    return 'updated'
  }

  writeFileSync(shimPath, content, { encoding: 'utf-8', mode: platform === 'win32' ? 0o644 : 0o755 })
  if (platform !== 'win32') chmodSync(shimPath, 0o755)
  return 'installed'
}

function writeWindowsShimPair(
  shimPath: string,
  commandContent: string,
  powershellContent: string,
  marker: string,
): ShimInstallStatus {
  const powershellPath = shimPath.replace(/\.cmd$/i, '.ps1')
  const managedPaths = [shimPath, powershellPath]
  if (managedPaths.some((file) => {
    if (!existsSync(file)) return false
    return !isManagedShim(readFileSync(file, 'utf-8'), marker)
  })) {
    return 'skipped'
  }

  const commandStatus = writeShim(shimPath, commandContent, 'win32', marker)
  const powershellStatus = writeShim(powershellPath, powershellContent, 'win32', marker)
  if (commandStatus === 'installed') return 'installed'
  if (commandStatus === 'updated' || powershellStatus !== 'unchanged') return 'updated'
  return 'unchanged'
}

function shellProfilePaths(homeDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return []

  const shell = env.SHELL?.trim() || ''
  const name = shell.split('/').pop() || ''
  if (name === 'fish') return [join(homeDir, '.config', 'fish', 'conf.d', 'ekko-studio.fish')]
  if (name === 'bash') return [join(homeDir, '.bash_profile'), join(homeDir, '.bashrc')]
  if (name === 'zsh' || platform === 'darwin') return [join(homeDir, '.zprofile'), join(homeDir, '.zshrc')]
  return [join(homeDir, '.profile')]
}

function profileMentionsUserBin(content: string, homeDir: string): boolean {
  return content.includes('$HOME/bin')
    || content.includes('~/bin')
    || content.includes(resolve(homeDir, 'bin'))
}

function shellPathSnippet(platform: NodeJS.Platform, profilePath: string): string {
  if (platform !== 'win32' && profilePath.endsWith('.fish')) {
    return [
      '',
      PATH_MARKER_START,
      'fish_add_path -m "$HOME/bin"',
      PATH_MARKER_END,
      '',
    ].join('\n')
  }

  return [
    '',
    PATH_MARKER_START,
    'case ":$PATH:" in',
    '  *":$HOME/bin:"*) ;;',
    '  *) export PATH="$HOME/bin:$PATH" ;;',
    'esac',
    PATH_MARKER_END,
    '',
  ].join('\n')
}

function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
}

async function readWindowsUserPath(): Promise<string> {
  const command = [
    "$value = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($null -ne $value -and $value.Length -gt 0) { [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($value))) }",
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', powershellArgs(command), {
    encoding: 'utf-8',
    timeout: 3000,
    windowsHide: true,
  })
  const encoded = stdout.trim()
  return encoded.length > 0 ? Buffer.from(encoded, 'base64').toString('utf-8') : ''
}

async function writeWindowsUserPath(pathValue: string): Promise<void> {
  const command = [
    `$bytes = [Convert]::FromBase64String($env:${WINDOWS_USER_PATH_ENV_B64})`,
    '$value = [System.Text.Encoding]::UTF8.GetString($bytes)',
    "[Environment]::SetEnvironmentVariable('Path', $value, 'User')",
  ].join('; ')
  await execFileAsync('powershell.exe', powershellArgs(command), {
    encoding: 'utf-8',
    env: {
      ...process.env,
      [WINDOWS_USER_PATH_ENV_B64]: Buffer.from(pathValue, 'utf-8').toString('base64'),
    },
    timeout: 3000,
    windowsHide: true,
  })
}

async function ensureWindowsUserPath(binDir: string): Promise<boolean> {
  const currentPath = await readWindowsUserPath()

  if (pathContainsDir(currentPath, binDir, 'win32')) return false

  const separator = currentPath ? ';' : ''
  await writeWindowsUserPath(`${binDir}${separator}${currentPath}`)
  return true
}

function ensureUnixShellPath(homeDir: string, binDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (pathContainsDir(env.PATH, binDir, platform)) return false

  let updated = false
  for (const profilePath of shellProfilePaths(homeDir, platform, env)) {
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : ''
    if (existing.includes(PATH_MARKER_START) || profileMentionsUserBin(existing, homeDir)) continue

    mkdirSync(dirname(profilePath), { recursive: true })
    appendFileSync(profilePath, shellPathSnippet(platform, profilePath), 'utf-8')
    updated = true
    break
  }
  return updated
}

async function ensureUserBinOnPath(homeDir: string, binDir: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (platform === 'win32') {
    return await ensureWindowsUserPath(binDir)
  }
  return ensureUnixShellPath(homeDir, binDir, platform, env)
}

export async function installHermesStudioCliShim(options: CliShimInstallOptions = {}): Promise<CliShimInstallResult> {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const homeDir = options.homeDir || homedir()
  const binDir = resolve(homeDir, 'bin')
  const executablePath = executableForShim({
    env,
    executablePath: options.executablePath || process.execPath,
    platform,
  })
  const shimPath = shimPathForPlatform(binDir, platform)

  mkdirSync(binDir, { recursive: true })
  const commandContent = createShimContent(
    executablePath,
    platform,
    process.arch,
    options.runtimeVersion,
    options.nodePath,
    options.webUiScriptPath,
  )
  const status = platform === 'win32'
    ? writeWindowsShimPair(
        shimPath,
        commandContent,
        createPowerShellShimContent(
          executablePath,
          process.arch,
          options.runtimeVersion,
          options.nodePath,
          options.webUiScriptPath,
        ),
        SHIM_MARKER,
      )
    : writeShim(shimPath, commandContent, platform)
  if (status !== 'skipped') {
    const oldPaths = platform === 'win32'
      ? [join(binDir, 'hermes-studio.cmd'), join(binDir, 'hermes-studio.ps1')]
      : [join(binDir, 'hermes-studio')]
    // Remove the old managed command, without touching user-owned commands or
    // a Windows sidecar that a custom command may still depend on.
    const existingOldPaths = oldPaths.filter(path => existsSync(path))
    if (existingOldPaths.every(path => isManagedShim(readFileSync(path, 'utf-8'), SHIM_MARKER))) {
      for (const path of existingOldPaths) rmSync(path)
    }
  }
  const pathUpdated = await ensureUserBinOnPath(homeDir, binDir, platform, env).catch((err) => {
    console.warn(`[cli-shim] failed to update PATH: ${err instanceof Error ? err.message : String(err)}`)
    return false
  })

  return {
    shimPath,
    status,
    pathUpdated,
    reason: status === 'skipped' ? 'existing ekko-studio shim is not managed by Ekko Studio' : undefined,
  }
}

export async function installHermesStudioMcpShim(options: McpShimInstallOptions = {}): Promise<CliShimInstallResult> {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const homeDir = options.homeDir || homedir()
  const binDir = resolve(homeDir, 'bin')
  const shimPath = mcpShimPathForPlatform(binDir, platform)
  const nodePath = options.nodePath || process.execPath
  const scriptPath = options.scriptPath || resolve(process.cwd(), 'bin', 'ekko-studio-mcp.mjs')
  const webUiUrl = options.webUiUrl || 'http://127.0.0.1:8748'

  mkdirSync(binDir, { recursive: true })
  const commandContent = createMcpShimContent(nodePath, scriptPath, webUiUrl, platform)
  const status = platform === 'win32'
    ? writeWindowsShimPair(
        shimPath,
        commandContent,
        createMcpPowerShellShimContent(nodePath, scriptPath, webUiUrl),
        MCP_SHIM_MARKER,
      )
    : writeShim(shimPath, commandContent, platform, MCP_SHIM_MARKER)
  const legacyShimPath = join(binDir, platform === 'win32' ? 'hermes-studio-mcp.cmd' : 'hermes-studio-mcp')
  if (status !== 'skipped') {
    if (platform === 'win32') {
      writeWindowsShimPair(
        legacyShimPath,
        commandContent.replace('ekko-studio-mcp.ps1', 'hermes-studio-mcp.ps1'),
        createMcpPowerShellShimContent(nodePath, scriptPath, webUiUrl),
        MCP_SHIM_MARKER,
      )
    } else {
      writeShim(legacyShimPath, commandContent, platform, MCP_SHIM_MARKER)
    }
  }
  const pathUpdated = await ensureUserBinOnPath(homeDir, binDir, platform, env).catch((err) => {
    console.warn(`[cli-shim] failed to update PATH: ${err instanceof Error ? err.message : String(err)}`)
    return false
  })

  return {
    shimPath,
    status,
    pathUpdated,
    reason: status === 'skipped' ? 'existing ekko-studio-mcp shim is not managed by Ekko Studio' : undefined,
  }
}
