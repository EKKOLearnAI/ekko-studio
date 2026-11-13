import {
  createFileProvider,
  resolveProfileFilePath,
  isSensitivePath,
  MAX_EDIT_SIZE,
} from '../services/files/file-provider'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../public/multipart'

function requestedProfile(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function resolveRequestPath(ctx: any, relativePath: string): string {
  return resolveProfileFilePath(relativePath, requestedProfile(ctx))
}

async function createRequestFileProvider(ctx: any) {
  return createFileProvider(requestedProfile(ctx))
}

function withAbsolutePath<T extends { path: string }>(ctx: any, entry: T): T & { absolutePath: string } {
  return { ...entry, absolutePath: resolveRequestPath(ctx, entry.path) }
}

function handleError(ctx: any, err: any) {
  const code = err.code || 'unknown'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    not_found: 404,
    ENOENT: 404,
    already_exists: 409,
    permission_denied: 403,
    file_too_large: 413,
    not_a_directory: 400,
    not_a_file: 400,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

// GET /api/studio/files/list?path=
export async function list(ctx: any) {
  const relativePath = (ctx.query.path as string) || ''
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const entries = await provider.listDir(absPath)
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { entries: entries.map(entry => withAbsolutePath(ctx, entry)), path: relativePath, absolutePath: absPath }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// GET /api/studio/files/stat?path=
export async function stat(ctx: any) {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const info = await provider.stat(absPath)
    ctx.body = withAbsolutePath(ctx, info)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// GET /api/studio/files/read?path=
export async function read(ctx: any) {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const data = await provider.readFile(absPath)
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// PUT /api/studio/files/write  body: { path, content }
export async function write(ctx: any) {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// DELETE /api/studio/files/delete  body: { path, recursive? }
export async function remove(ctx: any) {
  const { path: relativePath, recursive } = (ctx.request.body || {}) as { path?: string; recursive?: boolean }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    if (recursive) {
      await provider.deleteDir(absPath)
    } else {
      await provider.deleteFile(absPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// POST /api/studio/files/rename  body: { oldPath, newPath }
export async function rename(ctx: any) {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (isSensitivePath(oldPath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absOld = resolveRequestPath(ctx, oldPath)
    const absNew = resolveRequestPath(ctx, newPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// POST /api/studio/files/mkdir  body: { path }
export async function mkdir(ctx: any) {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// POST /api/studio/files/copy  body: { srcPath, destPath }
export async function copy(ctx: any) {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  try {
    const absSrc = resolveRequestPath(ctx, srcPath)
    const absDest = resolveRequestPath(ctx, destPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// POST /api/studio/files/upload?path=  (multipart/form-data)
export async function upload(ctx: any) {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const parts = splitMultipart(raw, boundaryBuf)
  const provider = await createRequestFileProvider(ctx)
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message, code: 'invalid_request' }
        return
      }
      throw error
    }
    if (!filename) continue

    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File ${filename} too large`, code: 'file_too_large' }
      return
    }

    const filePath = targetDir ? `${targetDir}/${filename}` : filename
    if (isSensitivePath(filePath)) {
      ctx.status = 403
      ctx.body = { error: `Cannot overwrite sensitive file: ${filename}`, code: 'permission_denied' }
      return
    }

    const absPath = resolveRequestPath(ctx, filePath)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
}
