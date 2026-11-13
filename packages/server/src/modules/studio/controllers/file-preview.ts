import { basename } from 'path'
import { createFileProvider, resolveProfileFilePath } from '../services/files/file-provider'
import {
  assertPreviewFileSize,
  buildFileContentHeaders,
  getFilePreviewDescriptor,
} from '../services/files/file-preview'

function handlePreviewError(ctx: any, err: any): void {
  const code = err?.code || 'preview_failed'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    invalid_file: 400,
    not_a_file: 400,
    unsupported_preview: 415,
    not_found: 404,
    ENOENT: 404,
    permission_denied: 403,
    file_too_large: 413,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = Number(err?.status || statusMap[code] || 500)
  ctx.body = { error: err?.message || 'Failed to preview file', code }
}

export async function previewProfileFile(ctx: any): Promise<void> {
  const relativePath = typeof ctx.query?.path === 'string' ? ctx.query.path : ''
  if (!relativePath) {
    handlePreviewError(ctx, Object.assign(new Error('Missing path parameter'), { code: 'missing_path' }))
    return
  }

  try {
    const descriptor = getFilePreviewDescriptor(relativePath)
    if (!descriptor) {
      throw Object.assign(new Error('File type is not supported for preview'), {
        code: 'unsupported_preview',
        status: 415,
      })
    }
    const profile = ctx.state?.profile?.name
    const fullPath = resolveProfileFilePath(relativePath, profile)
    const provider = await createFileProvider(profile)
    const info = await provider.stat(fullPath)
    if (info.isDir) {
      throw Object.assign(new Error('Not a file'), { code: 'not_a_file', status: 400 })
    }
    assertPreviewFileSize(info.size, descriptor)
    const data = await provider.readFile(fullPath)
    assertPreviewFileSize(data.length, descriptor)
    const headers = buildFileContentHeaders({
      fileName: basename(relativePath),
      mime: descriptor.mime,
      size: data.length,
    })
    for (const [name, value] of Object.entries(headers)) ctx.set(name, value)
    ctx.body = data
  } catch (err: any) {
    handlePreviewError(ctx, err)
  }
}
