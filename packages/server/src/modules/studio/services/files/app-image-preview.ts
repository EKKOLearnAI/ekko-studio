const APP_IMAGE_MAX_EDGE = 2048
const APP_IMAGE_MAX_PIXELS = 100 * 1024 * 1024
const APP_IMAGE_WEBP_QUALITY = 76
const COMPRESSIBLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const importSharp = () => import('sharp')

let sharpModulePromise: ReturnType<typeof importSharp> | undefined

function loadSharp(): ReturnType<typeof importSharp> {
  sharpModulePromise ??= importSharp()
  return sharpModulePromise
}

export interface AppImagePreview {
  data: Buffer
  mime: string
  optimized: boolean
  originalBytes: number
  width?: number
  height?: number
}

export interface AppImagePreviewOptions {
  maxEdge?: number
  quality?: number
  preserveAnimation?: boolean
}

/**
 * Builds the bandwidth-friendly image variant consumed by the mobile App.
 * The normal download route remains byte-for-byte unchanged unless the App
 * explicitly requests this variant.
 */
export async function createAppImagePreview(
  data: Buffer,
  mimeInput: string,
  options: AppImagePreviewOptions = {},
): Promise<AppImagePreview> {
  const mime = String(mimeInput || '').toLowerCase().split(';', 1)[0]
  const fallback = { data, mime: mime || 'application/octet-stream', optimized: false, originalBytes: data.length }
  if (!COMPRESSIBLE_IMAGE_TYPES.has(mime) || !data.length) return fallback

  const maxEdge = Math.max(1, Math.min(8192, Math.floor(options.maxEdge || APP_IMAGE_MAX_EDGE)))
  const quality = Math.max(1, Math.min(100, Math.floor(options.quality || APP_IMAGE_WEBP_QUALITY)))
  const preserveAnimation = options.preserveAnimation !== false

  try {
    const { default: sharp } = await loadSharp()
    const input = sharp(data, {
      animated: false,
      failOn: 'none',
      limitInputPixels: APP_IMAGE_MAX_PIXELS,
    })
    const metadata = await input.metadata()
    // Preserve animated PNG/WebP rather than silently returning only frame 1.
    if (preserveAnimation && Number(metadata.pages || 1) > 1) return fallback

    const orientation = Number(metadata.orientation || 1)
    const swapsAxes = orientation >= 5 && orientation <= 8
    const sourceWidth = Number(swapsAxes ? metadata.height : metadata.width)
    const sourceHeight = Number(swapsAxes ? metadata.width : metadata.height)
    if (!sourceWidth || !sourceHeight) return fallback

    const resized = await input
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer({ resolveWithObject: true })

    const downscaled = Math.max(sourceWidth, sourceHeight) > maxEdge
    // For already-small images, retain the original if WebP would cost more.
    if (!downscaled && resized.data.length >= data.length) {
      return { ...fallback, width: sourceWidth, height: sourceHeight }
    }
    return {
      data: resized.data,
      mime: 'image/webp',
      optimized: true,
      originalBytes: data.length,
      width: resized.info.width,
      height: resized.info.height,
    }
  } catch {
    // Unsupported or damaged images keep the normal download path.
    return fallback
  }
}
