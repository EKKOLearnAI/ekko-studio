import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { getActiveProfileDir, getHermesBaseDir, getProfileDir } from '../profiles/profile'
import { resolveAgentBridgeCommand } from '../bridge/manager'
import { safeFileStore } from '../../../studio/public/safe-file-store'

const execFileAsync = promisify(execFile)

export type HermesPluginSource = 'bundled' | 'user' | 'project' | 'entrypoint'
export type HermesPluginKind = 'standalone' | 'backend' | 'exclusive' | 'platform' | 'model-provider'
export type HermesPluginConfigStatus = 'enabled' | 'disabled' | 'not-enabled' | 'auto' | 'provider-managed'
export type HermesPluginEffectiveStatus = 'enabled' | 'disabled' | 'inactive' | 'auto-active' | 'provider-managed'

export interface HermesPluginInfo {
  key: string
  name: string
  kind: HermesPluginKind | string
  source: HermesPluginSource | string
  configStatus: HermesPluginConfigStatus
  effectiveStatus: HermesPluginEffectiveStatus
  version: string
  description: string
  author: string
  path: string
  providesTools: string[]
  providesHooks: string[]
  requiresEnv: Array<string | Record<string, unknown>>
}

export interface HermesPluginsMetadata {
  hermesAgentRoot: string
  pythonExecutable: string
  cwd: string
  projectPluginsEnabled: boolean
}

export interface HermesPluginsResponse {
  plugins: HermesPluginInfo[]
  warnings: string[]
  metadata: HermesPluginsMetadata
}

export interface HermesPluginMutationResult {
  key: string
  enabled: boolean
}

const PYTHON_BRIDGE = String.raw`
import importlib
import json
import os
import sys
import traceback
from pathlib import Path

warnings = []
agent_root = os.environ.get("HERMES_AGENT_ROOT_RESOLVED", "")

# python -c normally prepends the process cwd to sys.path. Remove it before any
# Hermes imports so an arbitrary WUI launch directory cannot shadow modules like
# hermes_cli, hermes_constants, utils, or yaml. The process cwd is still preserved
# separately for optional project-plugin scanning below.
sys.path = [entry for entry in sys.path if entry not in ("", os.getcwd())]
if agent_root:
    sys.path.insert(0, agent_root)

try:
    # Updated Hermes may select a new interpreter and dependency generation.
    # Finish its bootstrap before importing plugin/config dependencies.
    try:
        importlib.import_module("hermes_bootstrap")
    except ModuleNotFoundError as exc:
        if exc.name != "hermes_bootstrap":
            raise
    try:
        yaml = importlib.import_module("hermes_yaml")
    except ModuleNotFoundError as exc:
        if exc.name != "hermes_yaml":
            raise
        yaml = importlib.import_module("yaml")
    from hermes_cli.plugins import (
        PluginManager,
        get_bundled_plugins_dir,
        _get_disabled_plugins,
        _get_enabled_plugins,
    )
    from hermes_constants import get_hermes_home
except Exception as exc:
    print(json.dumps({
        "error": "Failed to import Hermes Agent plugin modules",
        "detail": str(exc),
        "traceback": traceback.format_exc(),
    }))
    sys.exit(2)


def env_enabled(name):
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


def safe_scan(label, fn):
    try:
        return fn()
    except Exception as exc:
        warnings.append(f"{label}: {exc}")
        return []


def coerce_list(value):
    return value if isinstance(value, list) else []


def read_manifest_list(plugin_path, *keys):
    try:
        plugin_dir = Path(plugin_path)
        manifest_file = plugin_dir / "plugin.yaml"
        if not manifest_file.exists():
            manifest_file = plugin_dir / "plugin.yml"
        if not manifest_file.exists():
            return []
        data = yaml.safe_load(manifest_file.read_text(encoding="utf-8")) or {}
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
        return []
    except Exception as exc:
        warnings.append(f"manifest metadata at {plugin_path}: {exc}")
        return []


def manifest_list(manifest, attr, *manifest_keys):
    value = coerce_list(getattr(manifest, attr, []))
    if value:
        return value
    return read_manifest_list(getattr(manifest, "path", ""), *manifest_keys)


def read_config_file(home):
    if not home:
        return {}
    try:
        path = Path(home) / "config.yaml"
        if not path.exists():
            return {}
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        warnings.append(f"plugin config at {home}: {exc}")
        return {}


def config_plugins_list(config, key):
    plugins = config.get("plugins")
    if not isinstance(plugins, dict):
        return None
    value = plugins.get(key)
    return set(value) if isinstance(value, list) else None


def merged_plugin_config():
    homes = []
    for home in (
        os.environ.get("HERMES_AGENT_BASE_HOME", ""),
        os.environ.get("HERMES_HOME", ""),
        str(get_hermes_home()),
    ):
        if home and home not in homes:
            homes.append(home)

    disabled = set()
    enabled = set()
    saw_enabled_key = False
    for home in homes:
        config = read_config_file(home)
        enabled_value = config_plugins_list(config, "enabled")
        if enabled_value is not None:
            saw_enabled_key = True
            enabled.update(enabled_value)
            disabled.difference_update(enabled_value)
        disabled_value = config_plugins_list(config, "disabled")
        if disabled_value is not None:
            disabled.update(disabled_value)
            enabled.difference_update(disabled_value)
    return disabled, (enabled if saw_enabled_key else None)

manager = PluginManager()
manifests = []

bundled_root = get_bundled_plugins_dir()
manifests.extend(safe_scan(
    f"bundled plugins at {bundled_root}",
    lambda: manager._scan_directory(
        bundled_root,
        source="bundled",
        skip_names={"platforms"},
    ),
))
manifests.extend(safe_scan(
    f"bundled platform plugins at {bundled_root / 'platforms'}",
    lambda: manager._scan_directory(bundled_root / "platforms", source="bundled"),
))

user_dir = get_hermes_home() / "plugins"
manifests.extend(safe_scan(
    f"user plugins at {user_dir}",
    lambda: manager._scan_directory(user_dir, source="user"),
))

project_plugins_enabled = env_enabled("HERMES_ENABLE_PROJECT_PLUGINS")
if project_plugins_enabled:
    project_dir = Path.cwd() / ".hermes" / "plugins"
    manifests.extend(safe_scan(
        f"project plugins at {project_dir}",
        lambda: manager._scan_directory(project_dir, source="project"),
    ))

manifests.extend(safe_scan(
    "pip entry-point plugins",
    lambda: manager._scan_entry_points(),
))

winners = {}
for manifest in manifests:
    key = manifest.key or manifest.name
    winners[key] = manifest

disabled, enabled = merged_plugin_config()
enabled_set = enabled if enabled is not None else set()

plugins = []
for key, manifest in sorted(winners.items(), key=lambda item: item[0].lower()):
    disabled_match = key in disabled or manifest.name in disabled
    enabled_match = key in enabled_set or manifest.name in enabled_set

    if disabled_match:
        config_status = "disabled"
        effective_status = "disabled"
    elif manifest.kind == "exclusive":
        config_status = "provider-managed"
        effective_status = "provider-managed"
    elif manifest.kind == "model-provider":
        config_status = "provider-managed"
        effective_status = "provider-managed"
    elif manifest.source == "bundled" and manifest.kind in ("backend", "platform"):
        config_status = "auto"
        effective_status = "auto-active"
    elif enabled_match:
        config_status = "enabled"
        effective_status = "enabled"
    else:
        config_status = "not-enabled"
        effective_status = "inactive"

    plugins.append({
        "key": key,
        "name": manifest.name,
        "kind": manifest.kind,
        "source": manifest.source,
        "configStatus": config_status,
        "effectiveStatus": effective_status,
        "version": manifest.version or "",
        "description": manifest.description or "",
        "author": manifest.author or "",
        "path": manifest.path or "",
        "providesTools": manifest_list(manifest, "provides_tools", "provides_tools", "tools"),
        "providesHooks": manifest_list(manifest, "provides_hooks", "provides_hooks", "hooks"),
        "requiresEnv": manifest_list(manifest, "requires_env", "requires_env"),
    })

print(json.dumps({
    "plugins": plugins,
    "warnings": warnings,
    "metadata": {
        "hermesAgentRoot": os.environ.get("HERMES_AGENT_ROOT_RESOLVED", ""),
        "pythonExecutable": sys.executable,
        "cwd": str(Path.cwd()),
        "projectPluginsEnabled": project_plugins_enabled,
    },
}))
`

function extractError(err: any): string {
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  return [err?.message, stdout, stderr].filter(Boolean).join('\n')
}

export async function listHermesPlugins(profile?: string): Promise<HermesPluginsResponse> {
  const command = resolveAgentBridgeCommand()
  const agentRoot = command.agentRoot || ''
  const hermesHome = profile ? getProfileDir(profile) : getActiveProfileDir()
  const hermesBaseHome = getHermesBaseDir()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_AGENT_ROOT_RESOLVED: agentRoot,
    HERMES_AGENT_BASE_HOME: hermesBaseHome,
    HERMES_HOME: hermesHome,
  }
  if (!agentRoot) {
    delete env.PYTHONHOME
    delete env.PYTHONPATH
  }
  const pythonArgs = [
    ...command.argsPrefix,
    ...(agentRoot ? ['-I'] : []),
    '-c',
    PYTHON_BRIDGE,
  ]
  const displayArgs = [
    ...command.argsPrefix,
    ...(agentRoot ? ['-I'] : []),
    '-c',
    '<plugin-discovery>',
  ].join(' ')

  const errors: string[] = []
  try {
    const { stdout, stderr } = await execFileAsync(command.command, pythonArgs, {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout) as HermesPluginsResponse & { error?: string; detail?: string }
    if ((parsed as any).error) {
      throw new Error(`${(parsed as any).error}: ${(parsed as any).detail || 'unknown error'}`)
    }
    if (stderr?.trim()) {
      parsed.warnings = [...(parsed.warnings || []), stderr.trim()]
    }
    return parsed
  } catch (err: any) {
    errors.push(`${command.command} ${displayArgs}: ${extractError(err)}`)
  }

  throw new Error(`Failed to discover Hermes plugins.\n${errors.join('\n')}`)
}

function configPathForProfile(profile?: string): string {
  return join(profile ? getProfileDir(profile) : getActiveProfileDir(), 'config.yaml')
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).map(value => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function isManageablePlugin(plugin: HermesPluginInfo): boolean {
  return plugin.kind === 'standalone' && plugin.source !== 'bundled'
}

function pluginAliases(plugin: HermesPluginInfo, requestedKey: string): string[] {
  return uniqueSorted([requestedKey, plugin.key, plugin.name])
}

export async function setHermesPluginEnabled(profile: string | undefined, key: string, enabled: boolean): Promise<HermesPluginMutationResult> {
  const pluginKey = String(key || '').trim()
  if (!pluginKey) throw new Error('Plugin key is required')

  const inventory = await listHermesPlugins(profile)
  const plugin = inventory.plugins.find(item => item.key === pluginKey || item.name === pluginKey)
  if (!plugin) throw new Error(`Plugin not found: ${pluginKey}`)
  if (!isManageablePlugin(plugin)) {
    throw new Error(`Plugin cannot be managed from Studio: ${plugin.key}`)
  }

  const aliases = pluginAliases(plugin, pluginKey)
  await safeFileStore.updateYaml(configPathForProfile(profile), (config) => {
    const plugins = config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? config.plugins
      : {}
    const currentEnabled: string[] = Array.isArray(plugins.enabled) ? plugins.enabled.map(String) : []
    const currentDisabled: string[] = Array.isArray(plugins.disabled) ? plugins.disabled.map(String) : []
    const aliasSet = new Set(aliases)

    if (enabled) {
      plugins.enabled = uniqueSorted([...currentEnabled.filter(value => !aliasSet.has(value)), plugin.key])
      plugins.disabled = uniqueSorted(currentDisabled.filter(value => !aliasSet.has(value)))
    } else {
      plugins.enabled = uniqueSorted(currentEnabled.filter(value => !aliasSet.has(value)))
      plugins.disabled = uniqueSorted([...currentDisabled.filter(value => !aliasSet.has(value)), plugin.key])
    }

    config.plugins = plugins
    return config
  }, {
    backup: true,
    dumpOptions: {
      forceQuotes: true,
    },
  })

  return { key: plugin.key, enabled }
}
