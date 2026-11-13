/**
 * Server-side identity stamping for the phase (a) update system.
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Identity Schema).
 * TS mirror of scripts/_lib/identity-stamp.sh — same tree-hash algorithm
 * (sha256 of the sorted "sha256  relative-path" lines of every file under
 * dist/), so a controller-side "Repair identity" re-stamp produces the
 * same value the orchestrator and the build pipeline agree on.
 *
 * `agentManifestSha` stays the settled sentinel "0.0.0-noop" until
 * phase (c) ships a real agent channel.
 */

import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { getWebUiHome } from '../../public/config'

export interface UpdateIdentityRecord {
  schema: 1
  capturedAt: string
  version: string
  distSha256: string
  installerScriptSha256: string
  agentManifestSha: string
  commitSha?: string
}

export const IDENTITY_AGENT_MANIFEST_SHA_SENTINEL = '0.0.0-noop'

export function identityFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(getWebUiHome(env), 'state', 'identity.json')
}

export function readUpdateIdentity(env: Record<string, string | undefined> = process.env): UpdateIdentityRecord | null {
  try {
    const path = identityFilePath(env)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as UpdateIdentityRecord
    if (!parsed || typeof parsed.version !== 'string' || !parsed.version) return null
    return parsed
  } catch {
    return null
  }
}

/** Hash over a deploy tree's dist/: identical algorithm to the shell stamp. */
export function computeDeployDistSha256(deployDir: string): string | null {
  const distDir = join(deployDir, 'dist')
  if (!existsSync(distDir)) return null
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!stat.isFile()) continue
      const sha = createHash('sha256').update(readFileSync(full)).digest('hex')
      lines.push(`${sha}  ${relative(deployDir, full).split(sep).join('/')}`)
    }
  }
  walk(distDir)
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex')
}

function readTreeVersion(deployDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(deployDir, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch { /* unreadable tree */ }
  return null
}

/**
 * Re-stamp identity.json from the CURRENT deploy tree. Idempotent and
 * non-destructive: repair is always "record what actually runs", never
 * "reinstall" (settled drift-repair decision).
 * Returns the stamped version, or null when the tree is unreadable.
 */
export function stampIdentityFromDeploy(
  deployDir: string,
  env: Record<string, string | undefined> = process.env,
): UpdateIdentityRecord | null {
  const version = readTreeVersion(deployDir)
  const distSha256 = computeDeployDistSha256(deployDir)
  if (!version || !distSha256) return null

  const record: UpdateIdentityRecord = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    version,
    distSha256,
    installerScriptSha256: process.env.HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256?.trim() || '',
    agentManifestSha: IDENTITY_AGENT_MANIFEST_SHA_SENTINEL,
  }

  const path = identityFilePath(env)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, path)
  return record
}
