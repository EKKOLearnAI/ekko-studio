import { nativeImage, type NativeImage } from 'electron'

export interface ScreenshotBitmap {
  width: number
  height: number
  data: Uint8Array
}

let channels: number[] | undefined

function bitmapChannels(): number[] {
  if (channels) return channels
  // toBitmap's channel order is platform-dependent. A single opaque pixel with
  // R=17, G=83, B=149 identifies the native order once without encoding a screen.
  const probe = nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQDJ76HwADawH5QLAvhwAAAABJRU5ErkJggg==', 'base64',
  )).toBitmap({ scaleFactor: 1 })
  const order = [17, 83, 149, 255].map(channel => probe.indexOf(channel))
  if (probe.length !== 4 || order.some(index => index < 0)) throw new Error('SCREENSHOT_INVALID_IMAGE')
  channels = order
  return channels
}

/** Keep full-screen pixels lossless, and defer PNG encoding until the crop is confirmed. */
export function screenshotBitmap(image: NativeImage): ScreenshotBitmap {
  const scaleFactor = Math.max(...image.getScaleFactors())
  const logical = image.getSize(scaleFactor)
  const pixels = image.toBitmap({ scaleFactor })
  let width = Math.round(logical.width * scaleFactor)
  let height = Math.round(logical.height * scaleFactor)
  // Electron reports integer DIP dimensions even for a Retina representation.
  // Recover fractional-scale rounding from the bitmap's exact pixel count.
  if (width * height * 4 !== pixels.length) {
    for (let candidate = Math.max(1, Math.floor(logical.width * scaleFactor)); candidate < Math.ceil((logical.width + 1) * scaleFactor); candidate++) {
      const rows = pixels.length / (candidate * 4)
      if (Number.isInteger(rows) && rows >= Math.floor(logical.height * scaleFactor) && rows < Math.ceil((logical.height + 1) * scaleFactor)) {
        width = candidate
        height = rows
        break
      }
    }
  }
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || !Number.isInteger(width) || !Number.isInteger(height)
    || width <= 0 || height <= 0 || pixels.length !== width * height * 4) throw new Error('SCREENSHOT_INVALID_IMAGE')
  const [red, green, blue, alpha] = bitmapChannels()
  const data = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + alpha]
    // Native bitmaps use premultiplied alpha; ImageData expects straight alpha.
    const factor = a === 0 ? 0 : 255 / a
    data[i] = Math.min(255, Math.round(pixels[i + red] * factor))
    data[i + 1] = Math.min(255, Math.round(pixels[i + green] * factor))
    data[i + 2] = Math.min(255, Math.round(pixels[i + blue] * factor))
    data[i + 3] = a
  }
  return { width, height, data }
}
