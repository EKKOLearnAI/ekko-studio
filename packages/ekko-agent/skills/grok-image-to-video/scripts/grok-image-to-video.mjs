#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'

const HELP = `Usage:
  grok-image-to-video.mjs --image-path <absolute path> --prompt <text> [options]

Options:
  --profile <name>
  --duration <1-15>
  --output-path <absolute path.mp4>
  --timeout-ms <milliseconds>
`

const ALLOWED = new Set(['image-path', 'prompt', 'profile', 'duration', 'output-path', 'timeout-ms'])

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }))
  process.exit(1)
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    process.exit(0)
  }
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) fail(`Unexpected argument: ${argument}`)
    const key = argument.slice(2)
    if (!ALLOWED.has(key)) fail(`Unknown option: --${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`Missing value for --${key}`)
    values[key] = value
    index += 1
  }
  return values
}

function firstToken() {
  const environmentToken = String(process.env.AUTH_TOKEN || '').trim()
  if (environmentToken) return environmentToken
  const candidates = [
    process.env.HERMES_WEB_UI_HOME && join(process.env.HERMES_WEB_UI_HOME, '.token'),
    process.env.HERMES_WEBUI_STATE_DIR && join(process.env.HERMES_WEBUI_STATE_DIR, '.token'),
    join(homedir(), '.hermes-web-ui', '.token'),
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    try {
      const token = readFileSync(candidate, 'utf8').trim()
      if (token) return token
    } catch {}
  }
  return ''
}

const options = parseArgs(process.argv.slice(2))
const imagePath = String(options['image-path'] || '').trim()
const prompt = String(options.prompt || '').trim()
if (!imagePath) fail('--image-path is required.')
if (!isAbsolute(imagePath)) fail('--image-path must be an absolute path.')
if (!existsSync(imagePath)) fail(`--image-path does not exist: ${imagePath}`)
if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(imagePath).toLowerCase())) {
  fail('--image-path must be a PNG, JPEG, or WebP image.')
}
if (!prompt) fail('--prompt is required.')

const duration = options.duration === undefined ? 8 : Number(options.duration)
if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
  fail('--duration must be an integer from 1 to 15.')
}
const requestedTimeout = options['timeout-ms'] === undefined ? 600_000 : Number(options['timeout-ms'])
if (!Number.isFinite(requestedTimeout) || requestedTimeout < 10_000) {
  fail('--timeout-ms must be at least 10000.')
}
const timeoutMs = Math.min(Math.floor(requestedTimeout), 1_800_000)
const outputPath = String(options['output-path'] || '').trim()
if (outputPath && !isAbsolute(outputPath)) fail('--output-path must be an absolute path.')
if (outputPath && extname(outputPath).toLowerCase() !== '.mp4') fail('--output-path must end in .mp4.')

const token = firstToken()
if (!token) {
  fail('Missing Ekko Studio server token. Check AUTH_TOKEN, HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR, or ~/.hermes-web-ui/.token.')
}
const baseUrl = String(
  process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${process.env.PORT || '8648'}`,
).replace(/\/+$/, '')
const profile = String(options.profile || process.env.EKKO_PROFILE || process.env.HERMES_WEB_UI_PROFILE || '').trim()
const body = {
  image_path: imagePath,
  prompt,
  duration,
  timeout_ms: timeoutMs,
  ...(outputPath ? { output_path: outputPath } : {}),
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000)
let response
try {
  response = await fetch(`${baseUrl}/api/studio/media/grok-image-to-video`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(profile ? { 'X-Hermes-Profile': profile } : {}),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
} catch (error) {
  clearTimeout(timer)
  fail(error?.name === 'AbortError' ? 'Ekko Studio video request timed out.' : `Ekko Studio connection failed: ${error?.message || error}`)
}
clearTimeout(timer)

const text = await response.text()
let result
try {
  result = text ? JSON.parse(text) : {}
} catch {
  result = { error: text || response.statusText }
}
if (!response.ok) {
  fail(String(result.error || `Ekko Studio returned HTTP ${response.status}.`), {
    status: response.status,
    code: result.code,
    request_id: result.request_id,
  })
}
const generatedPath = String(result.output_path || '').trim()
if (!generatedPath || !existsSync(generatedPath)) {
  fail('Ekko Studio reported success without a verifiable MP4 output.', {
    request_id: result.request_id,
    output_path: generatedPath,
  })
}
console.log(JSON.stringify({ ...result, output_path: generatedPath, output_verified: true }, null, 2))
