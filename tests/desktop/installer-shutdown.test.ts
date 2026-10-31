import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows installer shutdown hook', () => {
  it('stops child runtime processes that still reference the installed app', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain('HERMES_STUDIO_INSTALL_DIR')
    expect(script).toContain('Get-HermesStudioRelatedProcess')
    expect(script).toContain('desktop-runtime\\active-version.json')
    expect(script).toContain('(?:ekko|hermes)-studio-mcp|hermes_bridge\\.py|hermes_cli\\.main gateway run')
    expect(script).toContain('Stop-Process -Id')
  })

  it('does not terminate the installer or uninstaller process tree', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain("New-Object 'System.Collections.Generic.HashSet[int]'")
    expect(script).toContain('$$current.ParentProcessId')
    expect(script).toContain('if ($$currentExe -and $$currentExe -ieq $$target) { break }')
    expect(script).toContain('$$protectedProcessIds.Contains([int]$$_.ProcessId)')
    expect(script.indexOf('$$protectedProcessIds.Contains')).toBeLessThan(script.indexOf('$$cmd.IndexOf($$installDir'))
  })

  it('waits for graceful app shutdown before force-stopping remaining processes', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')
    const gracefulDeadline = script.indexOf('$$gracefulDeadline = (Get-Date).AddSeconds(30)')
    const forceDeadline = script.indexOf('$$forceDeadline = (Get-Date).AddSeconds(5)', gracefulDeadline)
    const forceStop = script.indexOf('Stop-Process -Id $$_.ProcessId -Force', gracefulDeadline)

    expect(script).not.toContain(`nsExec::ExecToLog '"$INSTDIR\\\${EXE_NAME}" --quit'`)
    expect(script).toContain("Start-Process -FilePath $$target -ArgumentList '--quit' -PassThru -ErrorAction Stop")
    expect(script).toContain('$$quitProcess.WaitForExit(5000)')
    expect(script.indexOf('FileWrite $0 "Request-StudioQuit')).toBeLessThan(gracefulDeadline)
    expect(script).toContain('!insertmacro stopStudioExecutable "Ekko Studio.exe" ekko')
    expect(script).toContain('!insertmacro stopStudioExecutable "Hermes Studio.exe" hermes')
    expect(gracefulDeadline).toBeGreaterThan(-1)
    expect(forceDeadline).toBeGreaterThan(gracefulDeadline)
    expect(forceStop).toBeGreaterThan(forceDeadline)
    expect(script.slice(gracefulDeadline, forceDeadline)).not.toContain('Stop-Process')
  })

  it('replaces the broken installed uninstaller before upgrading', () => {
    const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')

    expect(script).toContain('!macro repairHermesStudioUninstaller')
    expect(script).toContain('${UNINSTALL_FILENAME}.hermes-repair')
    expect(script).toContain('${UNINSTALL_FILENAME}.hermes-backup')
    expect(script).toContain('!insertmacro repairHermesStudioUninstaller')
  })
})

function emittedPowerShell(): string {
  const script = readFileSync(resolve('packages/desktop/build/installer.nsh'), 'utf8')
  const escapes: Record<string, string> = { '$$': '$', '$\\"': '"', '$\\r': '\r', '$\\n': '\n' }
  return [...script.matchAll(/^\s*FileWrite \$0 "(.*)"$/gm)]
    .map(match => match[1].replace(/\$\$|\$\\"|\$\\r|\$\\n/g, value => escapes[value]))
    .join('')
}

describe.skipIf(process.platform !== 'win32')('Windows installer quit helper execution', () => {
  it.each(['exited', 'blocked', 'missing'])('continues cleanup when the old quit helper is %s', state => {
    const root = mkdtempSync(join(tmpdir(), 'ekko-quit-helper-'))
    const encodedScript = Buffer.from(emittedPowerShell()).toString('base64')
    const encodedRoot = Buffer.from(root).toString('base64')
    // Execute the function emitted by NSIS against an isolated fake EXE.
    // The blocked fixture deliberately outlives WaitForExit and is cleaned up
    // by identity below; no installed Desktop or installer is touched.
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedScript}'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Request-StudioQuit'}, $true)
if (-not $function) { throw 'Missing quit helper function' }
. ([ScriptBlock]::Create($function.Extent.Text))
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'))
$target = Join-Path $root 'Quit helper.exe'
$record = Join-Path $root 'child.txt'
$env:EKKO_TEST_QUIT_CHILD_RECORD = $record
$env:EKKO_TEST_QUIT_CHILD_DELAY = '${state === 'blocked' ? 30000 : 0}'
if ('${state}' -ne 'missing') {
  Add-Type -OutputAssembly $target -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public class QuitFixture {
  public static void Main(string[] args) {
    File.WriteAllText(Environment.GetEnvironmentVariable("EKKO_TEST_QUIT_CHILD_RECORD"),
      Process.GetCurrentProcess().Id + "|" + String.Join(" ", args));
    Thread.Sleep(Int32.Parse(Environment.GetEnvironmentVariable("EKKO_TEST_QUIT_CHILD_DELAY")));
  }
}
'@ | Out-Null
}
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
  Request-StudioQuit
  $elapsed = $watch.ElapsedMilliseconds
  $child = $null
  $childArgs = ''
  if (Test-Path -LiteralPath $record) {
    $fields = (Get-Content -LiteralPath $record -Raw).Split('|')
    $childArgs = $fields[1]
    $child = Get-Process -Id ([int]$fields[0]) -ErrorAction SilentlyContinue
  }
  @{reachedCleanup=$true; elapsedMs=$elapsed; childAlive=($null -ne $child); childArgs=$childArgs} | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $record) {
    $childId = [int](Get-Content -LiteralPath $record -Raw).Split('|')[0]
    $ownedChild = Get-Process -Id $childId -ErrorAction SilentlyContinue
    if ($ownedChild -and $ownedChild.Path -eq $target) { Stop-Process -InputObject $ownedChild -Force }
  }
}
exit 0`
    try {
      // The fixture does not use Visual Studio; stale SDK search paths on a
      // developer machine must not turn C# compiler warnings into failures.
      const env = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !['LIB', 'LIBPATH', 'INCLUDE'].includes(key.toUpperCase())))
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { env, encoding: 'utf8', timeout: 25_000 })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!)
      expect(result.reachedCleanup).toBe(true)
      expect(result.elapsedMs).toBeLessThan(15_000)
      expect(result.childAlive).toBe(state === 'blocked')
      if (state !== 'missing') expect(result.childArgs).toBe('--quit')
      if (state === 'blocked') expect(result.elapsedMs).toBeGreaterThanOrEqual(4900)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 30_000)
})
