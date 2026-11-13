import type { Context } from 'koa'
import {
  MultipartParseError,
  parseMultipartBoundary,
  parseMultipartFilename,
  splitMultipart,
} from '../../studio/public/multipart'
import { importEkkoSkill, type EkkoSkillUpload } from '../services/skill-import'
import {
  createEkkoSkill,
  deleteEkkoSkill,
  getEkkoSkill,
  getEkkoSkillFile,
  listEkkoExternalSkillDirectories,
  listEkkoSkillFiles,
  listEkkoSkills,
  setEkkoSkillEnabled,
  updateEkkoExternalSkillDirectories,
  updateEkkoSkill,
} from '../services/skills'

const MAX_SKILL_UPLOAD_BYTES = 50 * 1024 * 1024

function requestedProfile(ctx: Context): string {
  return String(ctx.state?.profile?.name || 'default').trim() || 'default'
}

function errorResponse(ctx: Context, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  ctx.status = /not found/i.test(message) ? 404 : 400
  ctx.body = { ok: false, error: message }
}

export async function list(ctx: Context): Promise<void> {
  try {
    const skills = await listEkkoSkills(
      requestedProfile(ctx),
      String(ctx.query.query || ''),
    )
    ctx.body = { ok: true, skills }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function detail(ctx: Context): Promise<void> {
  try {
    const skill = await getEkkoSkill(requestedProfile(ctx), ctx.params.name)
    ctx.body = { ok: true, skill }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function files(ctx: Context): Promise<void> {
  try {
    ctx.body = {
      ok: true,
      files: await listEkkoSkillFiles(requestedProfile(ctx), ctx.params.name),
    }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function file(ctx: Context): Promise<void> {
  const path = String(ctx.query.path || '').trim()
  if (!path) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'path is required.' }
    return
  }
  try {
    ctx.body = {
      ok: true,
      content: await getEkkoSkillFile(requestedProfile(ctx), ctx.params.name, path),
    }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function toggle(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { ok: false, error: 'enabled is required.' }
    return
  }
  try {
    await setEkkoSkillEnabled(requestedProfile(ctx), ctx.params.name, body.enabled)
    ctx.body = { ok: true }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function externalDirectories(ctx: Context): Promise<void> {
  try {
    ctx.body = {
      ok: true,
      directories: await listEkkoExternalSkillDirectories(requestedProfile(ctx)),
    }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function saveExternalDirectories(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (!Array.isArray(body.directories) || body.directories.some(value => typeof value !== 'string')) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'directories must be an array of strings.' }
    return
  }
  try {
    updateEkkoExternalSkillDirectories(requestedProfile(ctx), body.directories as string[])
    ctx.body = { ok: true }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function importSkill(ctx: Context): Promise<void> {
  try {
    const parsed = await readSkillUpload(ctx)
    const skill = await importEkkoSkill(
      requestedProfile(ctx),
      parsed.uploads,
      parsed.category,
    )
    ctx.status = 201
    ctx.body = { ok: true, name: skill.name, skill }
  } catch (error) {
    if (error instanceof UploadTooLargeError) ctx.status = 413
    else errorResponse(ctx, error)
    if (!ctx.body) ctx.body = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function create(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.name !== 'string' || typeof body.content !== 'string') {
    ctx.status = 400
    ctx.body = { ok: false, error: 'name and content are required.' }
    return
  }
  try {
    const skill = await createEkkoSkill(requestedProfile(ctx), {
      name: body.name,
      content: body.content,
      ...(typeof body.category === 'string' && body.category ? { category: body.category } : {}),
    })
    ctx.status = 201
    ctx.body = { ok: true, skill }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function update(ctx: Context): Promise<void> {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (typeof body.content !== 'string') {
    ctx.status = 400
    ctx.body = { ok: false, error: 'content is required.' }
    return
  }
  try {
    const skill = await updateEkkoSkill(
      requestedProfile(ctx),
      ctx.params.name,
      body.content,
    )
    ctx.body = { ok: true, skill }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

export async function remove(ctx: Context): Promise<void> {
  try {
    await deleteEkkoSkill(requestedProfile(ctx), ctx.params.name)
    ctx.body = { ok: true }
  } catch (error) {
    errorResponse(ctx, error)
  }
}

class UploadTooLargeError extends Error {}

async function readSkillUpload(ctx: Context): Promise<{
  uploads: EkkoSkillUpload[]
  category: string
}> {
  const boundary = parseMultipartBoundary(ctx.get('content-type') || '')
  if (!boundary) throw new Error('Expected multipart/form-data.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of ctx.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_SKILL_UPLOAD_BYTES) {
      throw new UploadTooLargeError(`Upload too large (max ${MAX_SKILL_UPLOAD_BYTES / 1024 / 1024}MB).`)
    }
    chunks.push(buffer)
  }

  const uploads: EkkoSkillUpload[] = []
  let category = ''
  try {
    for (const part of splitMultipart(Buffer.concat(chunks), boundary)) {
      const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
      if (headerEnd < 0) continue
      const header = part.subarray(0, headerEnd).toString('utf8')
      const field = header.match(/Content-Disposition:\s*form-data;[^\r\n]*\bname="([^"]+)"/i)?.[1]
      if (!field) continue
      const dataEnd = part.length >= 2 && part.subarray(part.length - 2).equals(Buffer.from('\r\n'))
        ? part.length - 2
        : part.length
      const data = part.subarray(headerEnd + 4, dataEnd)
      const filename = parseMultipartFilename(header)
      if (field === 'file' && filename) uploads.push({ filename, data })
      else if (field === 'category' && filename === null) category = data.toString('utf8').trim()
    }
  } catch (error) {
    if (error instanceof MultipartParseError) throw new Error(error.message)
    throw error
  }
  if (!uploads.length) throw new Error('No files received.')
  return { uploads, category }
}
