// Convert a source video into the shared desktop/mobile thinking animation.
// Requires ffmpeg on PATH. The source video is left untouched.
// node scripts/generate-thinking-animation.mjs /path/to/video.mp4 [--app-root /path/to/app] [--preview /path/to/preview.gif]
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('--')) throw new Error('Pass the source video path as the first argument')
const source = resolve(args[0])
function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return resolve(args[index + 1])
}
const appRoot = option('--app-root')
const preview = option('--preview')
if (preview === source) throw new Error('Preview must not overwrite the source video')
const temp = await mkdtemp(join(tmpdir(), 'ekko-thinking-video-'))
function convert(size, output) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-filter_complex', `[0:v:0]fps=12.5,scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white,split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[out]`,
    '-map', '[out]', '-an', '-loop', '0', output,
  ])
}
try {
  const generated = join(temp, 'thinking.gif')
  convert(128, generated)
  const output = join(root, 'packages/client/src/assets/thinking.gif')
  await copyFile(generated, output)
  if (appRoot) await copyFile(generated, join(appRoot, 'static/thinking.gif'))
  if (preview) convert(256, preview)
  console.log(`Desktop: ${output}`)
  if (appRoot) console.log(`Mobile: ${join(appRoot, 'static/thinking.gif')}`)
  if (preview) console.log(`Preview: ${preview}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
