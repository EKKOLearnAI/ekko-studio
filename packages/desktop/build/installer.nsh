!macro stopStudioExecutable EXE_NAME LABEL
  IfFileExists "$INSTDIR\${EXE_NAME}" 0 studioStopDone_${LABEL}
    DetailPrint "Stopping Ekko Studio..."
    InitPluginsDir
    FileOpen $0 "$PLUGINSDIR\stop-hermes-studio.ps1" w
    FileWrite $0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
    FileWrite $0 "$$target = [System.IO.Path]::GetFullPath($$env:HERMES_STUDIO_EXE)$\r$\n"
    FileWrite $0 "$$installDir = [System.IO.Path]::GetFullPath($$env:HERMES_STUDIO_INSTALL_DIR)$\r$\n"
    FileWrite $0 "$$webUiHome = Join-Path $$env:USERPROFILE '.hermes-web-ui'$\r$\n"
    ; Older Desktop versions can show an installation warning even for --quit.
    ; Bound that helper's lifetime wait before continuing the existing cleanup.
    FileWrite $0 "function Request-StudioQuit {$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    $$quitProcess = Start-Process -FilePath $$target -ArgumentList '--quit' -PassThru -ErrorAction Stop$\r$\n"
    FileWrite $0 "    try {$\r$\n"
    FileWrite $0 "      if (-not $$quitProcess.WaitForExit(5000)) { Write-Output 'Quit helper is still running; continuing process cleanup.' }$\r$\n"
    FileWrite $0 "    } finally { $$quitProcess.Dispose() }$\r$\n"
    FileWrite $0 "  } catch { Write-Output 'Could not send the quit request; continuing process cleanup.' }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Normalize-Path([string]$$path) {$\r$\n"
    FileWrite $0 "  try { if ($$path) { return [System.IO.Path]::GetFullPath($$path) } } catch {}$\r$\n"
    FileWrite $0 "  return ''$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$protectedProcessIds = New-Object 'System.Collections.Generic.HashSet[int]'$\r$\n"
    FileWrite $0 "$$cursorPid = [int]$$PID$\r$\n"
    FileWrite $0 "for ($$depth = 0; $$depth -lt 8 -and $$cursorPid -gt 0; $$depth++) {$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    $$current = Get-CimInstance Win32_Process -Filter $\"ProcessId = $$cursorPid$\"$\r$\n"
    FileWrite $0 "    if (-not $$current) { break }$\r$\n"
    FileWrite $0 "    $$currentExe = Normalize-Path $$current.ExecutablePath$\r$\n"
    FileWrite $0 "    if ($$currentExe -and $$currentExe -ieq $$target) { break }$\r$\n"
    FileWrite $0 "    $$protectedProcessIds.Add($$cursorPid) | Out-Null$\r$\n"
    FileWrite $0 "    if (-not $$current.ParentProcessId) { break }$\r$\n"
    FileWrite $0 "    $$cursorPid = [int]$$current.ParentProcessId$\r$\n"
    FileWrite $0 "  } catch { break }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Test-UnderPath([string]$$path, [string]$$root) {$\r$\n"
    FileWrite $0 "  $$normalizedPath = Normalize-Path $$path$\r$\n"
    FileWrite $0 "  $$normalizedRoot = Normalize-Path $$root$\r$\n"
    FileWrite $0 "  if (-not $$normalizedPath -or -not $$normalizedRoot) { return $$false }$\r$\n"
    FileWrite $0 "  $$rootWithSlash = $$normalizedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar$\r$\n"
    FileWrite $0 "  return $$normalizedPath.StartsWith($$rootWithSlash, [System.StringComparison]::OrdinalIgnoreCase)$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Get-DesktopRuntimeRoots {$\r$\n"
    FileWrite $0 "  $$roots = New-Object System.Collections.Generic.List[string]$\r$\n"
    FileWrite $0 "  $$active = Join-Path $$webUiHome 'desktop-runtime\active-version.json'$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    if (Test-Path -LiteralPath $$active) {$\r$\n"
    FileWrite $0 "      $$json = Get-Content -LiteralPath $$active -Raw -Encoding UTF8 | ConvertFrom-Json$\r$\n"
    FileWrite $0 "      foreach ($$value in @($$json.runtimeDirectory, $$json.runtimeRootDirectory)) {$\r$\n"
    FileWrite $0 "        $$normalized = Normalize-Path ([string]$$value)$\r$\n"
    FileWrite $0 "        if ($$normalized) { $$roots.Add($$normalized) }$\r$\n"
    FileWrite $0 "      }$\r$\n"
    FileWrite $0 "    }$\r$\n"
    FileWrite $0 "  } catch {}$\r$\n"
    FileWrite $0 "  $$defaultRoot = Join-Path $$webUiHome 'desktop-runtime\hermes'$\r$\n"
    FileWrite $0 "  $$normalizedDefault = Normalize-Path $$defaultRoot$\r$\n"
    FileWrite $0 "  if ($$normalizedDefault) { $$roots.Add($$normalizedDefault) }$\r$\n"
    FileWrite $0 "  return $$roots | Select-Object -Unique$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "function Get-HermesStudioProcess {$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process -Filter $\"Name = '${EXE_NAME}'$\" | Where-Object {$\r$\n"
    FileWrite $0 "    try { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } catch { $$false }$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$runtimeRoots = @(Get-DesktopRuntimeRoots)$\r$\n"
    FileWrite $0 "function Get-HermesStudioRelatedProcess {$\r$\n"
    FileWrite $0 "  Get-CimInstance Win32_Process | Where-Object {$\r$\n"
    FileWrite $0 "    if ($$protectedProcessIds.Contains([int]$$_.ProcessId)) { return $$false }$\r$\n"
    FileWrite $0 "    $$exe = Normalize-Path $$_.ExecutablePath$\r$\n"
    FileWrite $0 "    $$cmd = [string]$$_.CommandLine$\r$\n"
    FileWrite $0 "    if ($$exe -and $$exe -ieq $$target) { return $$true }$\r$\n"
    FileWrite $0 "    if ($$cmd -and $$cmd.IndexOf($$installDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $$true }$\r$\n"
    FileWrite $0 "    foreach ($$root in $$runtimeRoots) {$\r$\n"
    FileWrite $0 "      if ((Test-UnderPath $$exe $$root) -and ($$cmd -match '(?:ekko|hermes)-studio-mcp|hermes_bridge\.py|hermes_cli\.main gateway run')) { return $$true }$\r$\n"
    FileWrite $0 "    }$\r$\n"
    FileWrite $0 "    return $$false$\r$\n"
    FileWrite $0 "  }$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "Request-StudioQuit$\r$\n"
    FileWrite $0 "Get-HermesStudioProcess | ForEach-Object {$\r$\n"
    FileWrite $0 "  try {$\r$\n"
    FileWrite $0 "    $$process = Get-Process -Id $$_.ProcessId$\r$\n"
    FileWrite $0 "    if ($$process) { $$process.CloseMainWindow() | Out-Null }$\r$\n"
    FileWrite $0 "  } catch {}$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$gracefulDeadline = (Get-Date).AddSeconds(30)$\r$\n"
    FileWrite $0 "while ((Get-Date) -lt $$gracefulDeadline) {$\r$\n"
    FileWrite $0 "  $$processes = @(Get-HermesStudioRelatedProcess)$\r$\n"
    FileWrite $0 "  if ($$processes.Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 500$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "$$forceDeadline = (Get-Date).AddSeconds(5)$\r$\n"
    FileWrite $0 "while ((Get-Date) -lt $$forceDeadline) {$\r$\n"
    FileWrite $0 "  $$processes = @(Get-HermesStudioRelatedProcess)$\r$\n"
    FileWrite $0 "  if ($$processes.Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "  $$processes | ForEach-Object { try { Stop-Process -Id $$_.ProcessId -Force } catch {} }$\r$\n"
    FileWrite $0 "  Start-Sleep -Milliseconds 250$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileWrite $0 "if (@(Get-HermesStudioRelatedProcess).Count -eq 0) { exit 0 }$\r$\n"
    FileWrite $0 "exit 1$\r$\n"
    FileClose $0

    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "$INSTDIR\${EXE_NAME}") i .r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_INSTALL_DIR", t "$INSTDIR") i .r0'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-hermes-studio.ps1"'
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_EXE", t "") i .r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "HERMES_STUDIO_INSTALL_DIR", t "") i .r0'
    nsExec::ExecToLog 'taskkill.exe /IM "${EXE_NAME}" /T /F'
    Pop $0
  studioStopDone_${LABEL}:
!macroend

!macro stopHermesStudioProcesses
  ; Close either installed product name when upgrading across the rename.
  !insertmacro stopStudioExecutable "Ekko Studio.exe" ekko
  !insertmacro stopStudioExecutable "Hermes Studio.exe" hermes
!macroend

!macro repairHermesStudioUninstaller
  IfFileExists "$INSTDIR\${UNINSTALL_FILENAME}" 0 hermesStudioRepairDone
    DetailPrint "Repairing Ekko Studio uninstaller..."
    SetOutPath "$INSTDIR"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}.hermes-repair"
    ClearErrors
    File "/oname=${UNINSTALL_FILENAME}.hermes-repair" "${UNINSTALLER_OUT_FILE}"
    IfErrors hermesStudioRepairDone

    ClearErrors
    Rename "$INSTDIR\${UNINSTALL_FILENAME}" "$INSTDIR\${UNINSTALL_FILENAME}.hermes-backup"
    IfErrors hermesStudioRepairCleanup
    Rename "$INSTDIR\${UNINSTALL_FILENAME}.hermes-repair" "$INSTDIR\${UNINSTALL_FILENAME}"
    IfErrors hermesStudioRepairRestore
    Delete "$INSTDIR\${UNINSTALL_FILENAME}.hermes-backup"
    Goto hermesStudioRepairDone

  hermesStudioRepairRestore:
    Rename "$INSTDIR\${UNINSTALL_FILENAME}.hermes-backup" "$INSTDIR\${UNINSTALL_FILENAME}"
  hermesStudioRepairCleanup:
    Delete "$INSTDIR\${UNINSTALL_FILENAME}.hermes-repair"
  hermesStudioRepairDone:
!macroend

!macro customInit
  !insertmacro stopHermesStudioProcesses
  !insertmacro repairHermesStudioUninstaller
!macroend

!macro customCheckAppRunning
  !insertmacro stopHermesStudioProcesses
!macroend
