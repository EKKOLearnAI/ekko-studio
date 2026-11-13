/**
 * Knowledge plugin — default-vault bootstrap (task-12, v0.8.9).
 *
 * On first start with KNOWLEDGE_DEFAULT_VAULTS=auto (the default), four
 * `kind='auto'` vaults are created so a fresh device has a usable
 * knowledge library with zero configuration (spec § "The four default
 * vaults"). Auto vaults ingest as metadata_only (the watcher branches on
 * kind), so bootstrapping them costs disk ~0 until the user promotes.
 *
 * Idempotent: keyed on `kind='auto' AND root_path`. The unique
 * root_path constraint is the backstop; a second run inserts nothing.
 *
 * Best-effort: a failure (read-only FS, missing parent) must NOT abort
 * service startup. Each vault is attempted independently; the aggregate
 * result is returned for logging and for `POST
 * /api/studio/knowledge/vaults/bootstrap-defaults` to surface. `off` skips the
 * whole thing and touches no manual vault.
 */

import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { KnowledgeService } from './knowledge.service'
import { getWebUiHome } from '../../public/config'

export type DefaultVaultsMode = 'auto' | 'off'

export interface BootstrapResult {
  created: string[]
  skipped: string[]
  failed: Array<{ path: string; reason: string }>
}

interface VaultPlan {
  name: string
  rootPath: string
  /** true → mkdir -p before insert (the path may not exist yet). */
  ensureDir: boolean
}

export function resolveDefaultVaultsMode(env: NodeJS.ProcessEnv = process.env): DefaultVaultsMode {
  const raw = (env.KNOWLEDGE_DEFAULT_VAULTS || 'auto').trim().toLowerCase()
  return raw === 'off' ? 'off' : 'auto'
}

/**
 * Resolve the four default-vault roots from the real environment, every
 * base path funnelled through getWebUiHome() (AGENTS.md: stateful
 * services never read HERMES_WEB_UI_HOME directly). The per-profile
 * workspace/notes live under HERMES_DATA_DIR, which the deploy pins to
 * the runtime hermes home.
 */
export function resolveDefaultRoots(
  env: NodeJS.ProcessEnv = process.env,
): { uploadDir: string; meetingsDir: string; hermesDataDir: string; profile: string } {
  const home = getWebUiHome(env)
  return {
    uploadDir: (env.UPLOAD_DIR || '').trim() || join(home, 'upload'),
    meetingsDir: join(home, 'meetings'),
    hermesDataDir: (env.HERMES_DATA_DIR || '').trim() || join(home, 'hermes_data'),
    profile: (env.HERMES_ACTIVE_PROFILE || 'default').trim() || 'default',
  }
}

/**
 * Build the four vault plans from resolved roots. Exposed separately so
 * tests can feed temp roots and assert the exact set (spec binding
 * contract) without touching the real home.
 */
export function planDefaultVaults(roots: {
  uploadDir: string
  meetingsDir: string
  hermesDataDir: string
  profile: string
}): VaultPlan[] {
  const profile = roots.profile || 'default'
  return [
    {
      name: '我的上传',
      rootPath: roots.uploadDir,
      ensureDir: true,
    },
    {
      name: 'Agent 工作区',
      rootPath: join(roots.hermesDataDir, profile, 'workspace'),
      ensureDir: false,
    },
    {
      name: '会议记录',
      rootPath: roots.meetingsDir,
      ensureDir: true,
    },
    {
      name: '用户笔记',
      rootPath: join(roots.hermesDataDir, profile, 'notes'),
      ensureDir: true,
    },
  ]
}

/**
 * Idempotently ensure the four default auto vaults exist. `existing` is
 * the caller's current vault list (so the function stays pure-ish and
 * testable); it inserts through `service.addVault(rootPath, name, 'auto')`.
 */
export function bootstrapDefaultVaults(
  service: KnowledgeService,
  opts: {
    mode?: DefaultVaultsMode
    roots: {
      uploadDir: string
      meetingsDir: string
      hermesDataDir: string
      profile: string
    }
    env?: NodeJS.ProcessEnv
  },
): BootstrapResult {
  const result: BootstrapResult = { created: [], skipped: [], failed: [] }
  const mode = opts.mode ?? resolveDefaultVaultsMode(opts.env ?? process.env)
  if (mode === 'off') return result

  const plans = planDefaultVaults(opts.roots)
  const existingByPath = new Set(service.listVaults().map(v => v.root_path))

  for (const plan of plans) {
    if (existingByPath.has(plan.rootPath)) {
      result.skipped.push(plan.rootPath)
      continue
    }
    try {
      if (plan.ensureDir && !existsSync(plan.rootPath)) {
        mkdirSync(plan.rootPath, { recursive: true })
      }
      // addVault enforces the flat 8-vault ceiling; if we are already at
      // the ceiling, bootstrap is best-effort — record and continue.
      service.addVault(plan.rootPath, plan.name, 'auto')
      result.created.push(plan.rootPath)
    } catch (err) {
      result.failed.push({
        path: plan.rootPath,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
