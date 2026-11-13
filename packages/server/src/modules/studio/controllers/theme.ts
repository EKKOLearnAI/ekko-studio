import type { Context } from 'koa'
import { MAX_THEME_ARCHIVE_BYTES, MAX_THEME_BACKGROUND_BYTES } from '../../../../../shared/theme-archive'
import { importThemeArchive, exportThemeArchive } from '../services/theme/archive'
import {
  listThemePresets, createThemePreset, renameThemePreset, activateThemePreset, deleteThemePreset,
  getUserTheme,
  saveUserTheme,
  toUserThemePayload,
  UserThemeValidationError,
  readThemeBackground,
  removeThemeBackground,
  replaceThemeBackground,
  ThemeBackgroundValidationError,
} from '../services/theme/user-theme'
import {
  MultipartParseError,
  parseMultipartBoundary,
  parseMultipartFilename,
  splitMultipart,
} from '../http/multipart'

const MAX_MULTIPART_BYTES = MAX_THEME_BACKGROUND_BYTES + 256 * 1024

function userId(ctx: Context): number | null {
  return ctx.state.user?.id || null
}

export async function getTheme(ctx: Context) {
  const id = userId(ctx)
  if (!id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  ctx.body = toUserThemePayload(getUserTheme(id))
}

export async function updateTheme(ctx: Context) {
  const id = userId(ctx)
  if (!id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  try {
    const body = ctx.request.body as Record<string, unknown> | undefined
    ctx.body = toUserThemePayload(saveUserTheme(id, body || {}))
  } catch (error) {
    if (error instanceof UserThemeValidationError) {
      ctx.status = error.status
      ctx.body = { error: error.message }
      return
    }
    throw error
  }
}

export async function uploadThemeBackground(ctx: Context) {
  const id = userId(ctx)
  if (!id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }

  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }
  const boundary = parseMultipartBoundary(contentType)
  if (!boundary) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary' }
    return
  }

  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > MAX_MULTIPART_BYTES) {
      ctx.status = 413
      ctx.body = { error: 'Background image exceeds the 30 MB limit' }
      return
    }
    chunks.push(chunk)
  }

  for (const part of splitMultipart(Buffer.concat(chunks), boundary)) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf-8')
    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message }
        return
      }
      throw error
    }
    if (!filename) continue

    try {
      const data = part.subarray(headerEnd + 4, part.length - 2)
      ctx.body = toUserThemePayload(await replaceThemeBackground(id, filename, data, ctx.query.presetId))
      return
    } catch (error) {
      if (error instanceof ThemeBackgroundValidationError || error instanceof UserThemeValidationError) {
        ctx.status = error.status
        ctx.body = { error: error.message }
        return
      }
      throw error
    }
  }

  ctx.status = 400
  ctx.body = { error: 'No background image was provided' }
}

export async function getThemeBackground(ctx: Context) {
  const id = userId(ctx)
  if (!id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  let background
  try { background = await readThemeBackground(id, ctx.query.presetId) }
  catch (error) {
    if (!(error instanceof UserThemeValidationError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message }
    return
  }
  if (!background) {
    ctx.status = 404
    ctx.body = { error: 'Background image not found' }
    return
  }
  ctx.type = background.mime
  ctx.set('Cache-Control', 'private, max-age=3600')
  ctx.set('ETag', `"theme-background-${background.updatedAt}"`)
  ctx.body = background.data
}

export async function deleteThemeBackground(ctx: Context) {
  const id = userId(ctx)
  if (!id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  try { ctx.body = toUserThemePayload(await removeThemeBackground(id, ctx.query.presetId)) }
  catch (error) {
    if (!(error instanceof UserThemeValidationError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message }
  }
}

async function presetAction(ctx: Context, operation: (id: number) => unknown) {
  const id = userId(ctx)
  if (!id) { ctx.status = 401; ctx.body = { error: 'Unauthorized' }; return }
  try { ctx.body = await operation(id) }
  catch (error) {
    if (!(error instanceof UserThemeValidationError || error instanceof ThemeBackgroundValidationError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message }
  }
}

export async function listPresets(ctx: Context) {
  await presetAction(ctx, id => listThemePresets(id))
}

export async function createPreset(ctx: Context) {
  const body = ctx.request.body as { name?: unknown; sourceId?: unknown; brightness?: unknown; style?: unknown } | undefined
  await presetAction(ctx, id => createThemePreset(id, body || {}))
}

export async function renamePreset(ctx: Context) {
  const body = ctx.request.body as { name?: unknown } | undefined
  await presetAction(ctx, id => renameThemePreset(id, ctx.params.id, body?.name))
}

export async function activatePreset(ctx: Context) {
  await presetAction(ctx, id => activateThemePreset(id, ctx.params.id))
}

export async function deletePreset(ctx: Context) {
  await presetAction(ctx, id => deleteThemePreset(id, ctx.params.id))
}

export async function importPreset(ctx: Context) {
  await presetAction(ctx, async id => {
    if (!ctx.is('application/zip', 'application/octet-stream')) throw new UserThemeValidationError('Expected a ZIP file', 415)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of ctx.req) {
      size += chunk.length
      if (size > MAX_THEME_ARCHIVE_BYTES) throw new UserThemeValidationError('Theme ZIP exceeds the 32 MB limit', 413)
      chunks.push(chunk)
    }
    return importThemeArchive(id, Buffer.concat(chunks), ctx.query)
  })
}

export async function exportPreset(ctx: Context) {
  await presetAction(ctx, async id => {
    const archive = await exportThemeArchive(id, ctx.params.id, ctx.query)
    ctx.type = 'application/zip'
    ctx.attachment(`${archive.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.zip`)
    ctx.set('Cache-Control', 'no-store')
    return archive.data
  })
}
