/**
 * Startup reconciliation for the group-chat large-document pipeline.
 *
 * Uploads stream the file to disk first and only register it in gc_documents
 * after parsing succeeds. If the process is killed mid-stream or mid-parse, the
 * file (and its .meta.json sidecar) survive but no gc_documents row exists — a
 * silent orphan that discussions later chase as a phantom file name. On boot we
 * scan group-chat-docs and either finish the registration (recovery) or mark
 * the upload failed so the UI can surface it. Registered docs whose file still
 * sits at `upload.bin` are renamed to the registered name so agent path hints
 * point at a readable (non-.bin) file.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { getWebUiHome } from '../../public/config'
import { logger } from '../../public/logging'
import { parseDocumentFile } from './document-parser'
import {
  insertChunks,
  insertFields,
  getDocument,
  saveDocument,
} from '../../repositories/document-store'

export interface DocumentReconcileResult {
  registered: string[]
  failed: string[]
  renamed: string[]
}

function fileSize(filePath: string): number {
  try { return statSync(filePath).size } catch { return 0 }
}

function findUploadFile(dir: string, preferredName: string): string | null {
  const candidates = preferredName ? [join(dir, preferredName), join(dir, 'upload.bin')] : [join(dir, 'upload.bin')]
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* missing */ }
  }
  return null
}

export function reconcileOrphanGroupDocuments(): DocumentReconcileResult {
  const result: DocumentReconcileResult = { registered: [], failed: [], renamed: [] }
  const docsRoot = resolve(getWebUiHome(), 'group-chat-docs')

  let rooms: string[]
  try { rooms = readdirSync(docsRoot) } catch { return result } // no docs dir yet

  for (const roomId of rooms) {
    const roomDir = join(docsRoot, roomId)
    let fileDirs: string[]
    try { fileDirs = readdirSync(roomDir) } catch { continue }
    for (const fileId of fileDirs) {
      const dir = join(roomDir, fileId)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }

      const existing = getDocument(fileId)
      if (existing) {
        // Keep the on-disk file name in sync with the registered name so agent
        // path hints point at a readable file (`.bin` is refused by file readers).
        const namedPath = join(dir, existing.name)
        const legacyPath = join(dir, 'upload.bin')
        if (!existsSync(namedPath) && existsSync(legacyPath)) {
          try {
            renameSync(legacyPath, namedPath)
            result.renamed.push(fileId)
            logger.info({ fileId, roomId, name: existing.name }, '[GroupChat] renamed legacy upload.bin to registered name')
          } catch (err) {
            logger.warn({ err, fileId }, '[GroupChat] failed to rename legacy upload.bin to registered name')
          }
        }
        continue
      }

      // Orphan: no gc_documents row. Recover from the sidecar if present.
      let meta: { fileName?: string } = {}
      try { meta = JSON.parse(readFileSync(join(dir, '.meta.json'), 'utf-8')) } catch { /* no meta */ }
      const candidate = findUploadFile(dir, meta.fileName || '')
      if (!candidate) continue // empty/partial dir — nothing to recover

      const name = meta.fileName || `orphan-${fileId.slice(0, 8)}.txt`
      try {
        const parsed = parseDocumentFile(candidate, name)
        if (parsed.chunks.length === 0) {
          throw Object.assign(new Error('Document contains no extractable text'), { code: 'doc_empty' })
        }
        const namedPath = join(dir, name)
        if (candidate !== namedPath && !existsSync(namedPath)) {
          try { renameSync(candidate, namedPath) } catch { /* keep candidate as fallback */ }
        }
        insertChunks(fileId, parsed.chunks)
        insertFields(fileId, parsed.fields)
        saveDocument({
          file_id: fileId,
          room_id: roomId,
          name,
          size_bytes: fileSize(namedPath) || fileSize(candidate),
          doc_type: parsed.docType,
          encoding: parsed.encoding,
          chunk_count: parsed.chunks.length,
          chunk_token_budget: 40000,
          status: 'chunked',
          report_message_id: '',
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        result.registered.push(fileId)
        logger.info({ fileId, roomId, name, chunks: parsed.chunks.length }, '[GroupChat] reconciled orphan document upload')
      } catch (err) {
        result.failed.push(fileId)
        try {
          const error = err instanceof Error ? err.message : String(err)
          writeFileSync(
            join(dir, '.meta.json'),
            JSON.stringify({ ...meta, status: 'failed', error: error.slice(0, 1000), updatedAt: Date.now() }, null, 2),
            'utf-8',
          )
        } catch { /* ignore */ }
        logger.warn({ err, fileId, roomId }, '[GroupChat] orphan document could not be parsed; marked failed')
      }
    }
  }
  return result
}
