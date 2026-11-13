import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getWebUiHome } from '../../studio/public/config'

interface ManagedMcpOverrides {
  disabled?: Record<string, Record<string, string[]>>
  configs?: Record<string, Record<string, Record<string, Record<string, unknown>>>>
}

function canonicalManagedName(name: string): string {
  if (name === 'ekko-studio-plan') return 'ekko-studio-interaction'
  return name.replace(/^hermes-studio-(api|browser|devices|use)$/, 'ekko-studio-$1')
}

function overridesPath(): string {
  return join(getWebUiHome(), 'coding-agent', 'mcp-overrides.json')
}

function readOverrides(): ManagedMcpOverrides {
  const path = overridesPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    for (const profiles of Object.values(parsed.disabled || {}) as Array<Record<string, string[]>>) {
      for (const [profile, names] of Object.entries(profiles)) {
        profiles[profile] = names.map(canonicalManagedName)
      }
    }
    for (const profiles of Object.values(parsed.configs || {}) as Array<Record<string, Record<string, unknown>>>) {
      for (const configs of Object.values(profiles)) {
        for (const name of Object.keys(configs)) {
          const canonical = canonicalManagedName(name)
          if (canonical === name) continue
          if (!Object.hasOwn(configs, canonical)) configs[canonical] = configs[name]
          delete configs[name]
        }
      }
    }
    return parsed
  } catch {
    return {}
  }
}

function writeOverrides(value: ManagedMcpOverrides): void {
  const path = overridesPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(path, 0o600)
}

export function getDisabledManagedMcpServers(id: string, profile = 'default'): Set<string> {
  const values = readOverrides().disabled?.[id]?.[profile] || []
  return new Set(values.map(String).filter(Boolean))
}

export function getManagedMcpServerOverride(
  id: string,
  profile: string,
  name: string,
): Record<string, unknown> {
  const value = readOverrides().configs?.[id]?.[profile]?.[canonicalManagedName(name)]
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

export function setManagedMcpServerOverride(
  id: string,
  profile: string,
  name: string,
  config: Record<string, unknown>,
): void {
  name = canonicalManagedName(name)
  const value = readOverrides()
  const configs = value.configs ||= {}
  const byAgent = configs[id] ||= {}
  const byProfile = byAgent[profile] ||= {}
  const persisted = { ...config }
  delete persisted.enabled
  if (Object.keys(persisted).length) byProfile[name] = persisted
  else delete byProfile[name]
  if (!Object.keys(byProfile).length) delete byAgent[profile]
  if (!Object.keys(byAgent).length) delete configs[id]
  if (!Object.keys(configs).length) delete value.configs
  writeOverrides(value)
}

export function setManagedMcpServerEnabled(
  id: string,
  profile: string,
  name: string,
  enabled: boolean,
): void {
  name = canonicalManagedName(name)
  const value = readOverrides()
  const disabled = value.disabled ||= {}
  const byAgent = disabled[id] ||= {}
  const names = new Set((byAgent[profile] || []).map(String).filter(Boolean))
  if (enabled) names.delete(name)
  else names.add(name)
  if (names.size) byAgent[profile] = [...names].sort()
  else delete byAgent[profile]
  if (!Object.keys(byAgent).length) delete disabled[id]
  if (!Object.keys(disabled).length) delete value.disabled
  writeOverrides(value)
}
