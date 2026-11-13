import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getWebUiHome } from '../../public/config'
import { canManageGroupChatRoom } from './access'
import { getGroupChatRuntimeServer } from './runtime'
import { parseDocumentFile } from './document-parser'
import { parseMultipartBoundary, streamMultipartFirstFile } from '../../http/multipart'
import { drainRejectedRequest } from '../../http/request-body'
import {
  countFields,
  countFacts,
  getChunkCounts,
  getDocument,
  getJobCounts,
  getVolumeSummaries,
  insertChunks,
  insertFields,
  insertJobs,
  listDocumentsByRoom,
  saveDocument,
  updateDocumentStatus,
  type GcDocumentRow,
} from '../../repositories/document-store'

const MAX_GROUP_DOC_SIZE = Number(process.env.MAX_GROUP_DOC_SIZE || 100 * 1024 * 1024) // 100MB default

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.docx'])

function managedRoom(ctx: any): { room: any; storage: any } {
  const server = getGroupChatRuntimeServer()
  if (!server) throw Object.assign(new Error('Group chat not initialized'), { status: 503, code: 'group_chat_unavailable' })
  const storage = server.getStorage()
  const room = storage.getRoom(ctx.params.roomId)
  if (!room) throw Object.assign(new Error('Room not found'), { status: 404, code: 'not_found' })
  if (!canManageGroupChatRoom(storage, room.id, ctx.state?.user)) {
    throw Object.assign(new Error('Access denied'), { status: 403, code: 'permission_denied' })
  }
  return { room, storage }
}

function handleDocError(ctx: any, error: any): void {
  ctx.status = Number(error?.status || 500)
  ctx.body = { error: error?.message || 'Group chat document error', code: error?.code || 'document_error' }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'document'
}

/** Sidecar marker written before/after streaming so a killed parse can be
 *  reconciled at next startup (see reconcileOrphanGroupDocuments). */
interface UploadMeta {
  fileId: string
  roomId: string
  originalName: string
  fileName: string
  status: 'uploading' | 'parsing' | 'registered' | 'failed'
  startedAt: number
  updatedAt: number
  error: string | null
}

async function writeUploadMeta(docsRoot: string, meta: UploadMeta): Promise<void> {
  await writeFile(join(docsRoot, '.meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
}

async function cleanupUpload(docsRoot: string): Promise<void> {
  try { await rm(docsRoot, { recursive: true, force: true }) } catch { /* best-effort */ }
}

export async function uploadDocument(ctx: any) {
  let docsRoot = ''
  try {
    const { room } = managedRoom(ctx)
    const contentType = ctx.get('content-type') || ''
    if (!contentType.startsWith('multipart/form-data')) {
      ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data', code: 'bad_request' }; return
    }
    const boundaryBuf = parseMultipartBoundary(contentType)
    if (!boundaryBuf) {
      ctx.status = 400; ctx.body = { error: 'Missing boundary', code: 'bad_request' }; return
    }

    const fileId = `gcd_${randomUUID()}`
    docsRoot = join(getWebUiHome(), 'group-chat-docs', ctx.params.roomId, fileId)
    await mkdir(docsRoot, { recursive: true })
    // Sidecar first: a process killed mid-stream or mid-parse leaves upload.bin
    // + meta behind, and the startup reconciliation re-registers it.
    const meta: UploadMeta = {
      fileId,
      roomId: ctx.params.roomId,
      originalName: '',
      fileName: '',
      status: 'uploading',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    }
    await writeUploadMeta(docsRoot, meta)

    let streamedName: string | null = null
    let streamedSize = 0
    try {
      const target = join(docsRoot, 'upload.bin')
      const written = await streamMultipartFirstFile(ctx.req, boundaryBuf, target, async (chunk) => {
        streamedSize += chunk.length
        if (streamedSize > MAX_GROUP_DOC_SIZE) {
          const err: any = new Error(`File too large (max ${Math.round(MAX_GROUP_DOC_SIZE / 1024 / 1024)}MB)`)
          err.status = 413
          err.code = 'file_too_large'
          throw err
        }
        if (chunk.length > 0) await writeFile(target, chunk, { flag: 'a' })
      })
      streamedName = written.filename
      if (!streamedName) {
        await cleanupUpload(docsRoot)
        ctx.status = 400; ctx.body = { error: 'No file part found', code: 'bad_request' }
        return
      }
    } catch (error: any) {
      if (error?.code === 'file_too_large' || error?.code === 'group_doc_size') {
        await cleanupUpload(docsRoot)
        await drainRejectedRequest(ctx.req)
        ctx.status = 413; ctx.body = { error: error.message, code: 'file_too_large' }
        return
      }
      throw error
    }

    const fileName = sanitizeFileName(streamedName)
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      await cleanupUpload(docsRoot)
      ctx.status = 415
      ctx.body = { error: `Unsupported file type "${ext || 'none'}". Supported: .txt .md .docx`, code: 'unsupported_doc_type' }
      return
    }

    // Keep the original (sanitized) extension on disk so agent file readers
    // accept it — the old `upload.bin` name is refused by the file-read tool.
    meta.originalName = streamedName
    meta.fileName = fileName
    meta.status = 'parsing'
    meta.updatedAt = Date.now()
    await writeUploadMeta(docsRoot, meta)
    const namedPath = join(docsRoot, fileName)
    try { await rename(join(docsRoot, 'upload.bin'), namedPath) } catch { /* keep upload.bin as fallback */ }

    // Parser reads the streamed bytes, chunks, and rule-extracts fields.
    const parsed = parseDocumentFile(namedPath, fileName)
    if (parsed.chunks.length === 0) {
      await cleanupUpload(docsRoot)
      ctx.status = 400; ctx.body = { error: 'Document contains no extractable text', code: 'doc_empty' }
      return
    }

    insertChunks(fileId, parsed.chunks)
    insertFields(fileId, parsed.fields)
    saveDocument({
      file_id: fileId,
      room_id: ctx.params.roomId,
      name: fileName,
      size_bytes: streamedSize,
      doc_type: parsed.docType,
      encoding: parsed.encoding,
      chunk_count: parsed.chunks.length,
      chunk_token_budget: 40000,
      status: 'chunked',
      report_message_id: '',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    meta.status = 'registered'
    meta.updatedAt = Date.now()
    await writeUploadMeta(docsRoot, meta)

    const server = getGroupChatRuntimeServer()
    server?.getIO().of('/group-chat')?.to(ctx.params.roomId).emit('document_ready', {
      roomId: ctx.params.roomId,
      fileId,
      name: fileName,
      docType: parsed.docType,
      encoding: parsed.encoding,
      chunkCount: parsed.chunks.length,
      fieldsCount: parsed.fields.length,
    })

    ctx.body = {
      fileId,
      name: fileName,
      sizeBytes: streamedSize,
      docType: parsed.docType,
      encoding: parsed.encoding,
      chunkCount: parsed.chunks.length,
      fieldsCount: parsed.fields.length,
      status: 'chunked',
    }
  } catch (error: any) {
    // Any HTTP-visible failure cleans up the partial dir so it never becomes an
    // orphan. Only a process kill (no response) leaves the dir for reconciliation.
    if (docsRoot) await cleanupUpload(docsRoot)
    await drainRejectedRequest(ctx.req)
    handleDocError(ctx, error)
  }
}

export async function getDocumentProgress(ctx: any) {
  try {
    const { room } = managedRoom(ctx)
    const fileId = ctx.params.fileId
    const doc = getDocument(fileId)
    if (!doc || doc.room_id !== room.id) {
      ctx.status = 404; ctx.body = { error: 'Document not found', code: 'not_found' }
      return
    }
    const chunks = getChunkCounts(fileId)
    const jobs = getJobCounts(fileId)
    const fieldsCount = countFields(fileId)
    const factsCount = countFacts(fileId)
    const progressPct = chunks.total > 0 ? Math.round((chunks.read / chunks.total) * 100) : 0
    ctx.body = {
      fileId,
      status: doc.status,
      name: doc.name,
      docType: doc.doc_type,
      encoding: doc.encoding,
      chunkCount: doc.chunk_count,
      chunksRead: chunks.read,
      chunksTotal: chunks.total,
      fieldsCount,
      factsCount,
      progressPct,
      jobs: { ...jobs, chunksDone: chunks.read },
      reportMessageId: doc.report_message_id || null,
    }
  } catch (error: any) {
    handleDocError(ctx, error)
  }
}

export async function listDocuments(ctx: any) {
  try {
    const { room } = managedRoom(ctx)
    const docs = listDocumentsByRoom(room.id)
    ctx.body = {
      documents: docs.map((doc: GcDocumentRow) => ({
        fileId: doc.file_id,
        name: doc.name,
        docType: doc.doc_type,
        encoding: doc.encoding,
        sizeBytes: doc.size_bytes,
        chunkCount: doc.chunk_count,
        status: doc.status,
        reportMessageId: doc.report_message_id || null,
        createdAt: doc.created_at,
      })),
    }
  } catch (error: any) {
    handleDocError(ctx, error)
  }
}

export async function startDocumentReading(ctx: any) {
  try {
    const { room, storage } = managedRoom(ctx)
    const fileId = ctx.params.fileId
    const doc = getDocument(fileId)
    if (!doc || doc.room_id !== room.id) {
      ctx.status = 404; ctx.body = { error: 'Document not found', code: 'not_found' }
      return
    }
    if (doc.status === 'reading' || doc.status === 'aggregating') {
      ctx.status = 409; ctx.body = { error: 'Document pipeline already running', code: 'already_running' }
      return
    }

    const roomAgents = storage.getRoomAgents(room.id) || []
    const requested = Array.isArray(ctx.request?.body?.agents) ? ctx.request.body.agents : []
    const selectedIds: string[] = (requested.length > 0 ? requested : roomAgents.map((a: any) => a.profile || a.name)).filter(Boolean)
    if (selectedIds.length === 0) {
      ctx.status = 400; ctx.body = { error: 'No agents in this room', code: 'no_agents' }
      return
    }

    // Resolve full agent model configs (profile/provider/model/apiMode) from the room.
    const agents = selectedIds
      .map((id: string) => roomAgents.find((a: any) => a.profile === id || a.name === id))
      .filter(Boolean)
      .map((a: any) => ({
        agentId: a.profile || a.agentId,
        profile: a.profile,
        provider: a.provider || '',
        model: a.model || '',
        apiMode: a.apiMode || '',
        name: a.name || a.profile,
      }))
    if (agents.length === 0) {
      ctx.status = 400; ctx.body = { error: 'Selected agents not found in this room', code: 'agent_not_found' }
      return
    }

    const server = getGroupChatRuntimeServer()
    const pipelineService = server?.getDocumentPipelineService()
    if (!pipelineService) {
      ctx.status = 503; ctx.body = { error: 'Document pipeline not initialized', code: 'group_chat_unavailable' }
      return
    }

    const result = await pipelineService.startReading(fileId, agents)
    ctx.body = { fileId, pipelineId: result.pipelineId, jobsAssigned: result.jobsAssigned }
  } catch (error: any) {
    handleDocError(ctx, error)
  }
}
