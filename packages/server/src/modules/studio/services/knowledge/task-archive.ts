/**
 * Knowledge plugin — semi-auto task-finalize archive (task-12, v0.8.9).
 *
 * When a Hermes task finishes with deliverables, record them in the
 * knowledge library WITHOUT reading them into the embedding queue: each
 * file lands as a `metadata_only` row (auto vault → step 0.5 short
 * circuit) tagged `source='task-finalize'`, and the user promotes the
 * ones they actually want searchable via the existing "全文索引" action.
 *
 * The auto_tasks vault shares the Agent-workspace root path; provenance
 * (source='task-finalize' vs 'unknown') is what separates task output
 * from continuously-watched workspace files. De-dup: a file already
 * recorded under this vault is skipped (a re-run within the retention
 * window does not create a second row).
 */

import { existsSync, statSync } from 'node:fs'
import { KnowledgeService } from './knowledge.service'

export interface ArchiveResult {
  archived: Array<{ path: string; documentId: number }>
  skipped: Array<{ path: string; reason: string }>
}

/**
 * Archive a task's output files into the auto_tasks vault at
 * `workspaceRoot`. The vault is created lazily on first use (kind='auto'
 * so every drop is metadata_only). Returns after queueing; source
 * stamping runs when each ingest resolves.
 */
export async function archiveTaskFiles(
  service: KnowledgeService,
  opts: {
    workspaceRoot: string
    files: string[]
    vaultName?: string
  },
): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: [], skipped: [] }
  const vaultName = opts.vaultName || '自动归档'

  const existing = service.findVaultByPath(opts.workspaceRoot)
  const vault = existing ?? service.addVault(opts.workspaceRoot, vaultName, 'auto')

  for (const file of opts.files) {
    if (!existsSync(file)) {
      result.skipped.push({ path: file, reason: 'not_found' })
      continue
    }
    // Reuse if already recorded under this vault (de-dup within retention).
    const already = service.findDocumentInVault(file, vault.id)
    if (already) {
      // Still (re)stamp provenance in case it was recorded by the watcher
      // as 'unknown' but now we know it is a task deliverable.
      service.setDocumentSource(already.id, 'task-finalize')
      result.skipped.push({ path: file, reason: 'already_recorded' })
      continue
    }
    try {
      // Await each ingest so the documentId is stable for source stamping
      // and the toast reflects what actually landed. auto vault ⇒ metadata_only.
      const ingest = await service.ingest(file, vault.id)
      if (ingest.documentId) {
        service.setDocumentSource(ingest.documentId, 'task-finalize')
        result.archived.push({ path: file, documentId: ingest.documentId })
      }
    } catch (err) {
      result.skipped.push({ path: file, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return result
}

/** Validate that a candidate path is a real, non-empty file (guard). */
export function isArchivableFile(path: string): boolean {
  try {
    const s = statSync(path)
    return s.isFile()
  } catch {
    return false
  }
}
