import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { safeFileStore } from '../../../studio/public/safe-file-store'
import { readAppConfig } from '../../../studio/public/app-config'
import { saveEnvValueInHome } from '../profiles/config'
import { resolveCopilotOAuthTokenWithSource } from './copilot-models'

const execFileAsync = promisify(execFile)
const COPILOT_PROVIDERS = new Set(['copilot', 'github-copilot', 'github', 'github-models', 'github-model'])

export interface CopilotRuntimeCommand {
  command: string
  argsPrefix: string[]
  agentRoot?: string
  hermesHome: string
}

const COPILOT_STATUS = String.raw`
import importlib
import json
import os
import sys
from pathlib import Path
root = os.environ.get("HERMES_AGENT_ROOT", "")
sys.path = [entry for entry in sys.path if entry not in ("", os.getcwd())]
if root:
    sys.path.insert(0, root)
try:
    importlib.import_module("hermes_bootstrap")
except ModuleNotFoundError as exc:
    if exc.name != "hermes_bootstrap":
        raise
try:
    migration = importlib.import_module("hermes_cli.left_core_migration")
except ModuleNotFoundError as exc:
    if exc.name != "hermes_cli.left_core_migration":
        raise
    migration = None
needs_plugin = bool(migration and getattr(migration, "provider_left_core", lambda _: False)("copilot"))
present = bool(needs_plugin and migration.plugin_present("github-copilot", Path(os.environ["HERMES_HOME"])))
print(json.dumps({"needs_plugin": needs_plugin, "present": present,
                  "hint": migration.provider_install_hint("copilot") if needs_plugin else ""}))
`

async function copilotStatus(command: CopilotRuntimeCommand) {
  const { stdout } = await execFileAsync(command.command, [...command.argsPrefix, '-c', COPILOT_STATUS], {
    env: {
      ...process.env,
      HERMES_HOME: command.hermesHome,
      ...(command.agentRoot ? { HERMES_AGENT_ROOT: command.agentRoot } : {}),
      HERMES_DISABLE_LAZY_INSTALLS: '1',
    },
    cwd: command.hermesHome,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout) as { needs_plugin: boolean; present: boolean; hint: string }
}

/** Called only after the user enables Copilot, or for a previously enabled profile. */
export async function prepareCopilotRuntime(
  command: CopilotRuntimeCommand,
  options: { token?: string; enableDisabled?: boolean; allowInstall?: boolean } = {},
): Promise<void> {
  await mkdir(command.hermesHome, { recursive: true })
  const envText = await readFile(join(command.hermesHome, '.env'), 'utf-8').catch(() => '')
  const token = (options.token || (await resolveCopilotOAuthTokenWithSource(envText, {
    inheritProcessEnv: basename(dirname(command.hermesHome)) !== 'profiles',
  })).token).trim()
  if (!token || /[\r\n]/.test(token)) throw new Error('GitHub Copilot requires sign-in before it can be enabled')
  const pending = await copilotStatus(command)
  if (pending.needs_plugin) {
    if (options.allowInstall === false) {
      throw new Error(pending.hint || 'The GitHub Copilot plugin must be installed explicitly')
    }
    if (pending.present && !options.enableDisabled) {
      throw new Error(pending.hint || 'The GitHub Copilot plugin is unavailable')
    }
    // Explicit provider activation may install its required plugin. Read-only
    // token detection and model catalog requests never take this path.
    await execFileAsync(command.command, [
      ...command.argsPrefix, '-m', 'hermes_cli.main', 'plugins',
      pending.present ? 'enable' : 'install', 'github-copilot',
      ...(!pending.present ? ['--yes'] : []),
    ], {
      cwd: command.hermesHome,
      env: {
        ...process.env,
        HERMES_HOME: command.hermesHome,
        ...(command.agentRoot ? { HERMES_AGENT_ROOT: command.agentRoot } : {}),
        HERMES_DISABLE_LAZY_INSTALLS: '1',
      },
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    const ready = await copilotStatus(command)
    if (ready.needs_plugin) throw new Error(ready.hint || 'The GitHub Copilot plugin could not be loaded')
  }

  // Hermes 0.23's plugin no longer reads gh/VS Code token files. Materialize
  // the accepted credential only in this profile, never in process.env.
  await saveEnvValueInHome(command.hermesHome, 'COPILOT_GITHUB_TOKEN', token)
}

export async function prepareConfiguredCopilotRuntime(command: CopilotRuntimeCommand): Promise<void> {
  const cfg = await safeFileStore.readYaml(join(command.hermesHome, 'config.yaml'))
  const selected = COPILOT_PROVIDERS.has(String(cfg.model?.provider || '').toLowerCase())
  const enabled = (await readAppConfig()).copilotEnabled === true
  if (!selected && !enabled) return
  const envText = await readFile(join(command.hermesHome, '.env'), 'utf-8').catch(() => '')
  const { token } = await resolveCopilotOAuthTokenWithSource(envText, {
    inheritProcessEnv: basename(dirname(command.hermesHome)) !== 'profiles',
  })
  if (!selected && !token) return
  const installDisabled = ['1', 'true', 'yes'].includes(String(process.env.HERMES_DISABLE_LAZY_INSTALLS || '').toLowerCase())
  await prepareCopilotRuntime(command, {
    token,
    allowInstall: cfg.security?.allow_lazy_installs !== false && !installDisabled,
  })
}
