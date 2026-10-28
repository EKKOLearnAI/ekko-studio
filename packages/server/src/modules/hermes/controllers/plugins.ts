import { listHermesPlugins, setHermesPluginEnabled } from '../services/plugins/plugins'
import { importPluginArchive, PluginImportError } from '../services/plugins/import'
import {
  MultipartParseError,
  parseMultipartBoundary,
  parseMultipartFilename,
  splitMultipart,
} from '../../studio/public/multipart'

const MAX_PLUGIN_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

export async function list(ctx: any) {
  try {
    ctx.body = await listHermesPlugins(ctx.state?.profile?.name)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to discover Hermes plugins' }
  }
}

export async function enable(ctx: any) {
  await setPluginEnabled(ctx, true)
}

export async function disable(ctx: any) {
  await setPluginEnabled(ctx, false)
}

async function setPluginEnabled(ctx: any, enabled: boolean) {
  try {
    const key = String(ctx.params?.key || '').trim()
    if (!key) {
      ctx.status = 400
      ctx.body = { error: 'Plugin key is required' }
      return
    }
    ctx.body = await setHermesPluginEnabled(ctx.state?.profile?.name, key, enabled)
  } catch (err: any) {
    const message = err.message || 'Failed to update Hermes plugin'
    ctx.status = message.includes('not found') ? 404 : message.includes('cannot be managed') ? 400 : 500
    ctx.body = { error: message }
  }
}

/**
 * Install a user plugin from an uploaded zip.
 *
 * Only an archive already on the operator's machine is accepted: nothing is
 * fetched from the network, so this endpoint cannot be talked into pulling code
 * from a URL. Route-level authorization keeps it to super admins.
 */
export async function importPlugin(ctx: any) {
  const boundary = parseMultipartBoundary(ctx.get('content-type') || '')
  if (!boundary) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }

  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > MAX_PLUGIN_UPLOAD_SIZE) {
      ctx.status = 413
      ctx.body = { error: `Upload too large (max ${MAX_PLUGIN_UPLOAD_SIZE / 1024 / 1024}MB)` }
      return
    }
    chunks.push(chunk)
  }

  let archive: Buffer | null = null
  let filename = ''
  let overwrite = false
  for (const part of splitMultipart(Buffer.concat(chunks), boundary)) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let partFilename: string | null
    try {
      partFilename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message }
        return
      }
      throw error
    }

    if (partFilename) {
      archive = data
      filename = partFilename
      continue
    }
    if (/\bname="overwrite"/i.test(header)) {
      overwrite = /^(1|true|yes)$/i.test(data.toString('utf-8').trim())
    }
  }

  if (!archive || archive.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No plugin archive received' }
    return
  }
  if (!filename.toLowerCase().endsWith('.zip')) {
    ctx.status = 400
    ctx.body = { error: 'Plugin must be uploaded as a .zip archive' }
    return
  }

  try {
    const result = await importPluginArchive({
      archive,
      filename,
      profile: ctx.state?.profile?.name,
      overwrite,
    })
    ctx.body = { success: true, plugin: result }
  } catch (err: any) {
    if (err instanceof PluginImportError) {
      ctx.status = err.status
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to import plugin' }
  }
}
