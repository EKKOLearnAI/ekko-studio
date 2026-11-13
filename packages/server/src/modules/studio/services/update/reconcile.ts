import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { config, getWebUiHome } from '../../public/config'
import { UpdateError } from './errors'
import type { DeviceEnvironment, DeviceEnvironmentFile } from './types'

const RECONCILE_INTERVAL_MS = 30 * 60 * 1000
const RECONCILE_FIRST_DELAY_MS = 60 * 1000

export type EnvironmentCheckStatus = 'ok' | 'drift_detected' | 'unavailable'

export interface DriftEntry {
  gate: 'requiredNodeRange' | 'requiredHermesAgentRange' | 'requiredSystemFiles' | 'installerScriptSha256'
  expected: string
  actual: string
  detail?: string
}

export interface CapturedEnvironment {
  version: string
  capturedAt: string
  nodeVersion: string
  agentVersion: string
  aptPackages: string[]
  scripts: { install?: string }
  driftFromManifest: DriftEntry[]
}

export interface LastEnvironmentCheck {
  status: EnvironmentCheckStatus
  capturedAt: string | null
  manifestVersion: string | null
  actualVersion: string | null
  nodeVersion: string | null
  agentVersion: string | null
  drift: DriftEntry[]
  reconcileSupported: boolean
  checkedAt: string
}

let lastEnvironmentCheck: LastEnvironmentCheck = {
  status: 'unavailable',
  capturedAt: null,
  manifestVersion: null,
  actualVersion: null,
  nodeVersion: null,
  agentVersion: null,
  drift: [],
  reconcileSupported: false,
  checkedAt: '',
}

let reconcileTimer: NodeJS.Timeout | null = null

function envStatePath(): string {
  return resolve(getWebUiHome(), 'env-state.json')
}

function parseSemverTuple(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec((value || '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compareTuples(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] - b[2]
}

function satisfiesRange(range: string | undefined, actual: string): boolean {
  if (!range || !actual) return true
  const actualTuple = parseSemverTuple(actual)
  if (!actualTuple) return true
  const trimmed = range.trim()
  if (trimmed.startsWith('>=')) {
    const target = parseSemverTuple(trimmed.slice(2))
    return target ? compareTuples(actualTuple, target) >= 0 : true
  }
  if (trimmed.startsWith('<=')) {
    const target = parseSemverTuple(trimmed.slice(2))
    return target ? compareTuples(actualTuple, target) <= 0 : true
  }
  if (trimmed.startsWith('>')) {
    const target = parseSemverTuple(trimmed.slice(1))
    return target ? compareTuples(actualTuple, target) > 0 : true
  }
  if (trimmed.startsWith('<')) {
    const target = parseSemverTuple(trimmed.slice(1))
    return target ? compareTuples(actualTuple, target) < 0 : true
  }
  if (trimmed.startsWith('~')) {
    const target = parseSemverTuple(trimmed.slice(1))
    if (!target) return true
    return actualTuple[0] === target[0] && actualTuple[1] === target[1] && actualTuple[2] >= target[2]
  }
  if (trimmed.startsWith('^')) {
    const target = parseSemverTuple(trimmed.slice(1))
    if (!target) return true
    if (target[0] !== 0) return actualTuple[0] === target[0] && compareTuples(actualTuple, target) >= 0
    if (target[1] !== 0) return actualTuple[0] === 0 && actualTuple[1] === target[1] && actualTuple[2] >= target[2]
    return actualTuple[0] === 0 && actualTuple[1] === 0 && actualTuple[2] === target[2]
  }
  return true
}

function resolveFilePath(declaredPath: string, deployDir: string): string {
  if (declaredPath.startsWith('/')) return declaredPath
  return resolve(deployDir, declaredPath)
}

/**
 * Pure drift computation. Given a captured device environment and the
 * manifest-declared environment block, return the list of failing gates.
 */
export function assertEnvironmentMatches(
  state: CapturedEnvironment | null | undefined,
  manifest: DeviceEnvironment,
  options: { deployDir?: string } = {},
): DriftEntry[] {
  const drift: DriftEntry[] = []
  if (!state) return drift
  const deployDir = options.deployDir || getWebUiHome()

  if (manifest.requiredNodeRange) {
    if (!satisfiesRange(manifest.requiredNodeRange, state.nodeVersion)) {
      drift.push({
        gate: 'requiredNodeRange',
        expected: manifest.requiredNodeRange,
        actual: state.nodeVersion,
      })
    }
  }

  if (manifest.requiredHermesAgentRange) {
    if (!satisfiesRange(manifest.requiredHermesAgentRange, state.agentVersion)) {
      drift.push({
        gate: 'requiredHermesAgentRange',
        expected: manifest.requiredHermesAgentRange,
        actual: state.agentVersion,
      })
    }
  }

  if (Array.isArray(manifest.requiredSystemFiles)) {
    for (const entry of manifest.requiredSystemFiles) {
      const missing = checkSystemFileMismatch(entry, deployDir)
      if (missing) drift.push(missing)
    }
  }

  return drift
}

function checkSystemFileMismatch(entry: DeviceEnvironmentFile, deployDir: string): DriftEntry | null {
  const absolute = resolveFilePath(entry.path, deployDir)
  const exists = existsSync(absolute)
  const executable = exists && (() => {
    try {
      // We don't import fs.accessSync here to keep this sync; use stat instead.
      const stat = require('fs').statSync(absolute)
      return (stat.mode & 0o111) !== 0
    } catch {
      return false
    }
  })()
  if (entry.kind === 'present' && !exists) {
    return { gate: 'requiredSystemFiles', expected: 'present', actual: 'absent', detail: entry.path }
  }
  if (entry.kind === 'executable' && !executable) {
    return {
      gate: 'requiredSystemFiles',
      expected: 'executable',
      actual: exists ? 'not-executable' : 'absent',
      detail: entry.path,
    }
  }
  if (entry.kind === 'absent' && exists) {
    return { gate: 'requiredSystemFiles', expected: 'absent', actual: 'present', detail: entry.path }
  }
  return null
}

/**
 * Read the device-side env-state.json produced by install-device-package.sh.
 * Returns null when the file is missing or unreadable; in that case the
 * caller should report 'unavailable' rather than fail.
 */
export async function readDeviceEnvState(): Promise<CapturedEnvironment | null> {
  const path = envStatePath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      version: typeof parsed.version === 'string' ? parsed.version : '',
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
      nodeVersion: typeof parsed.nodeVersion === 'string' ? parsed.nodeVersion : 'unknown',
      agentVersion: typeof parsed.agentVersion === 'string' ? parsed.agentVersion : 'unknown',
      aptPackages: Array.isArray(parsed.aptPackages) ? parsed.aptPackages.map(String) : [],
      scripts: parsed.scripts && typeof parsed.scripts === 'object' ? {
        install: typeof parsed.scripts.install === 'string' ? parsed.scripts.install : undefined,
      } : {},
      driftFromManifest: Array.isArray(parsed.driftFromManifest) ? parsed.driftFromManifest : [],
    }
  } catch {
    return null
  }
}

export function getLastEnvironmentCheck(): LastEnvironmentCheck {
  return lastEnvironmentCheck
}

/**
 * Recompute the in-memory environment check from on-disk state and the
 * most recent device-package manifest. Returns the new state.
 */
export async function runEnvironmentCheck(): Promise<LastEnvironmentCheck> {
  const now = new Date().toISOString()
  const state = await readDeviceEnvState()

  let manifest: { version: string; environment?: DeviceEnvironment } | null = null
  try {
    if (config.update.strategy === 'device-package') {
      const { fetchDevicePackageManifest } = await import('./manifest-client')
      manifest = await fetchDevicePackageManifest(config.update)
    }
  } catch (err) {
    if (!(err instanceof UpdateError)) {
      console.warn('[reconcile] manifest refresh failed:', err instanceof Error ? err.message : String(err))
    }
  }

  const drift = state && manifest?.environment
    ? assertEnvironmentMatches(state, manifest.environment, { deployDir: config.update.installerScript ? resolve(config.update.installerScript, '..') : getWebUiHome() })
    : []

  const next: LastEnvironmentCheck = {
    status: !state ? 'unavailable' : drift.length === 0 ? 'ok' : 'drift_detected',
    capturedAt: state?.capturedAt ?? null,
    manifestVersion: manifest?.version ?? null,
    actualVersion: state?.version ?? null,
    nodeVersion: state?.nodeVersion ?? null,
    agentVersion: state?.agentVersion ?? null,
    drift,
    reconcileSupported: Boolean(manifest?.environment),
    checkedAt: now,
  }
  lastEnvironmentCheck = next
  return next
}

/**
 * Schedule the periodic environment check. Safe to call multiple times —
 * only one loop is active at a time.
 */
export function startReconcileLoop(): void {
  if (reconcileTimer) return
  if (config.update.strategy !== 'device-package') return
  setTimeout(() => {
    void runEnvironmentCheck().catch((err) => {
      console.warn('[reconcile] initial check failed:', err instanceof Error ? err.message : String(err))
    })
  }, RECONCILE_FIRST_DELAY_MS)
  reconcileTimer = setInterval(() => {
    void runEnvironmentCheck().catch((err) => {
      console.warn('[reconcile] periodic check failed:', err instanceof Error ? err.message : String(err))
    })
  }, RECONCILE_INTERVAL_MS)
  if (typeof (reconcileTimer as any).unref === 'function') {
    ;(reconcileTimer as any).unref()
  }
}

export function stopReconcileLoop(): void {
  if (!reconcileTimer) return
  clearInterval(reconcileTimer)
  reconcileTimer = null
}

/** Test helper — reset module state between cases. */
export function __resetEnvironmentCheckForTest(): void {
  stopReconcileLoop()
  lastEnvironmentCheck = {
    status: 'unavailable',
    capturedAt: null,
    manifestVersion: null,
    actualVersion: null,
    nodeVersion: null,
    agentVersion: null,
    drift: [],
    reconcileSupported: false,
    checkedAt: '',
  }
}