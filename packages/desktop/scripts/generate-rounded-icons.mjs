import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const buildDir = new URL('../build/', import.meta.url)
// Keep the original artwork intact while rounding the tile's outside corners.
function renderRounded(size, radius) {
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * radius}" fill="white"/></svg>`)
  return sharp(fileURLToPath(new URL('icon.png', buildDir)))
    .resize(size, size)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

// Linux shells display the supplied silhouette; leave space around the tile
// so its visual weight matches neighboring launcher icons.
await mkdir(new URL('icons/', buildDir), { recursive: true })
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  const padding = Math.round(size / 16)
  const tile = await renderRounded(size - padding * 2, 0.2)
  const icon = await sharp(tile)
    .extend({ top: padding, bottom: padding, left: padding, right: padding, background: '#00000000' })
    .png()
    .toBuffer()
  await writeFile(new URL(`icons/${size}x${size}.png`, buildDir), icon)
  if (size === 512) await writeFile(new URL('iconLinux.png', buildDir), icon)
}

const windowsRadius = 0.16
await writeFile(new URL('iconWindows.png', buildDir), await renderRounded(1024, windowsRadius))
for (const [name, pixels, radius] of [
  ['trayMac.png', 22, 0.26],
  ['trayMac@2x.png', 44, 0.26],
  ['trayWindows.png', 256, windowsRadius],
  ['trayLinux.png', 256, 0.26],
]) {
  await writeFile(new URL(name, buildDir), await renderRounded(pixels, radius))
}

// PNG-backed ICO entries retain alpha at both standard and high-DPI sizes.
const iconSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const entries = await Promise.all(iconSizes.map(size => renderRounded(size, windowsRadius)))
const header = Buffer.alloc(6 + 16 * entries.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(entries.length, 4)
let offset = header.length
for (let index = 0; index < entries.length; index++) {
  const entry = 6 + index * 16
  header[entry] = iconSizes[index] === 256 ? 0 : iconSizes[index]
  header[entry + 1] = header[entry]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(entries[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += entries[index].length
}
await writeFile(new URL('icon.ico', buildDir), Buffer.concat([header, ...entries]))
