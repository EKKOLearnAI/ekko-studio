import { authorizeShareDownload } from '../services/session-shares/access'
import { basename, extname, isAbsolute } from 'path'
import {
  createFileProvider,
  localProvider,
  isInUploadDir,
  validatePath,
  resolveProfileFilePath,
} from '../services/files/file-provider'
import { getActiveProfileName } from '../public/profile-config'
import { createAppImagePreview } from '../services/files/app-image-preview'

// MIME type mapping for common extensions
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.py': 'text/x-python',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.log': 'text/plain',
}

function getMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function download(ctx: any) {
  const filePath = ctx.query.path as string | undefined
  const fileName = ctx.query.name as string | undefined
  const variant = ctx.query.variant as string | undefined

  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }

  try {
    const profile = requestedProfile(ctx)
    // Validate the path first
    // Support both absolute and relative paths
    const validPath = ctx.state?.sessionShare
      ? await authorizeShareDownload(ctx.state.sessionShare, filePath)
      : isAbsolute(filePath) ? validatePath(filePath) : resolveProfileFilePath(filePath, profile)

    // Choose provider: always use local for upload directory files
    let data: Buffer
    if (ctx.state?.sessionShare || isInUploadDir(validPath)) {
      data = await localProvider.readFile(validPath)
    } else {
      const provider = await createFileProvider(profile)
      data = await provider.readFile(validPath)
    }

    // Determine filename and MIME type
    const name = fileName || basename(validPath)
    let mime = getMimeType(name)
    let responseData = data
    if (variant === 'app-image') {
      const preview = await createAppImagePreview(data, mime)
      responseData = preview.data
      mime = preview.mime
      ctx.set('X-Hermes-Image-Variant', preview.optimized ? 'compressed' : 'original')
      ctx.set('X-Hermes-Original-Bytes', String(preview.originalBytes))
    }

    // Set response headers
    ctx.set('Content-Type', mime)
    ctx.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.set('Content-Length', String(responseData.length))
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.body = responseData
  } catch (err: any) {
    const code = err.code || 'unknown'
    const statusMap: Record<string, number> = {
      missing_path: 400,
      invalid_path: 400,
      not_found: 404,
      ENOENT: 404,
      file_too_large: 413,
      unsupported_backend: 501,
      backend_error: 502,
      backend_timeout: 504,
    }
    ctx.status = Number(err.status) || statusMap[code] || 500
    ctx.body = { error: err.message, code }
  }
}
