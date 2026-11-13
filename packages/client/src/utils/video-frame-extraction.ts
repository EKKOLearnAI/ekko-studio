const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'ogv', 'ogg'])
const DEFAULT_FRAME_COUNT = 3
const DEFAULT_MAX_DIMENSION = 1280
const VIDEO_LOAD_TIMEOUT_MS = 10_000
const VIDEO_SEEK_TIMEOUT_MS = 6_000

function fileExtension(name: string): string {
  const baseName = name.split(/[\\/]/).pop() || ''
  const dot = baseName.lastIndexOf('.')
  return dot >= 0 ? baseName.slice(dot + 1).toLowerCase() : ''
}

export function isVideoFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.toLowerCase().startsWith('video/') || VIDEO_EXTENSIONS.has(fileExtension(file.name))
}

export function representativeVideoFrameTimes(duration: number, frameCount = DEFAULT_FRAME_COUNT): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || frameCount <= 0) return []
  if (frameCount === 1) return [Math.min(duration / 2, Math.max(0, duration - 0.05))]

  const safeEnd = Math.max(0, duration - 0.05)
  const startRatio = 0.1
  const endRatio = 0.9
  const times = Array.from({ length: frameCount }, (_, index) => {
    const ratio = startRatio + ((endRatio - startRatio) * index) / (frameCount - 1)
    return Math.min(safeEnd, Math.max(0, duration * ratio))
  })
  return times.filter((time, index) => index === 0 || Math.abs(time - times[index - 1]) >= 0.01)
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener(eventName, handleSuccess)
      video.removeEventListener('error', handleError)
    }
    const handleSuccess = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(video.error || new Error(`Failed to decode video while waiting for ${eventName}`))
    }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out while waiting for video ${eventName}`))
    }, timeoutMs)

    video.addEventListener(eventName, handleSuccess, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode extracted video frame'))
    }, 'image/jpeg', 0.84)
  })
}

function frameDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function frameFileName(videoName: string, index: number): string {
  const baseName = (videoName.split(/[\\/]/).pop() || 'video').replace(/\.[^.]+$/, '') || 'video'
  return `${baseName}-video-frame-${String(index + 1).padStart(2, '0')}.jpg`
}

export async function extractRepresentativeVideoFrames(
  file: File,
  options: { frameCount?: number; maxDimension?: number } = {},
): Promise<File[]> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return []

  const frameCount = Math.max(1, Math.min(5, Math.round(options.frameCount || DEFAULT_FRAME_COUNT)))
  const maxDimension = Math.max(320, Math.min(1920, Math.round(options.maxDimension || DEFAULT_MAX_DIMENSION)))
  const video = document.createElement('video')
  const objectUrl = URL.createObjectURL(file)
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true

  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata', VIDEO_LOAD_TIMEOUT_MS)
    video.src = objectUrl
    video.load()
    await metadataReady

    if (!video.videoWidth || !video.videoHeight) return []
    const times = representativeVideoFrameTimes(video.duration, frameCount)
    if (times.length === 0) return []

    const dimensions = frameDimensions(video.videoWidth, video.videoHeight, maxDimension)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) return []

    const frames: File[] = []
    for (const [index, time] of times.entries()) {
      if (Math.abs(video.currentTime - time) >= 0.01) {
        const seeked = waitForVideoEvent(video, 'seeked', VIDEO_SEEK_TIMEOUT_MS)
        video.currentTime = time
        await seeked
      } else if (video.readyState < 2) {
        await waitForVideoEvent(video, 'loadeddata', VIDEO_SEEK_TIMEOUT_MS)
      }
      context.drawImage(video, 0, 0, dimensions.width, dimensions.height)
      const blob = await canvasBlob(canvas)
      frames.push(new File([blob], frameFileName(file.name, index), {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      }))
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
