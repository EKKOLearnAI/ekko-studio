#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const HELP = `Usage:
  studio-image-gen.mjs --mode <text|image|edit> --prompt <text> [options]

Options:
  --profile <name>
  --provider <name>
  --image-path <absolute path>
  --image-url <url>
  --size <width>x<height|auto>
  --quality <value>
  --n <count>
  --model <name>
  --image-model <name>
  --output-path <absolute path>
  --timeout-ms <milliseconds>
`

const ALLOWED = new Set([
  'mode',
  'prompt',
  'profile',
  'provider',
  'image-path',
  'image-url',
  'size',
  'quality',
  'n',
  'model',
  'image-model',
  'output-path',
  'timeout-ms',
])

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

function localAbsolutePath(value, option, mustExist = false) {
  if (!isAbsolute(value)) fail(`${option} must be an absolute path.`)
  if (mustExist && !existsSync(value)) fail(`${option} does not exist: ${value}`)
  return value
}

const options = parseArgs(process.argv.slice(2))
const mode = String(options.mode || '').trim()
const prompt = String(options.prompt || '').trim()
if (!['text', 'image', 'edit'].includes(mode)) fail('--mode must be text, image, or edit.')
if (!prompt) fail('--prompt is required.')
if ((mode === 'image' || mode === 'edit') && !options['image-path'] && !options['image-url']) {
  fail(`${mode} mode requires --image-path or --image-url.`)
}
if (options['image-path']) localAbsolutePath(options['image-path'], '--image-path', true)
if (options['output-path']) localAbsolutePath(options['output-path'], '--output-path')

const n = options.n === undefined ? 1 : Number(options.n)
if (!Number.isInteger(n) || n < 1 || n > 10) fail('--n must be an integer from 1 to 10.')
const requestedTimeout = options['timeout-ms'] === undefined ? 600_000 : Number(options['timeout-ms'])
if (!Number.isFinite(requestedTimeout) || requestedTimeout < 10_000) {
  fail('--timeout-ms must be at least 10000.')
}
const timeoutMs = Math.min(Math.floor(requestedTimeout), 1_800_000)

const token = firstToken()
if (!token) {
  fail('Missing Ekko Studio server token. Check AUTH_TOKEN, HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR, or ~/.hermes-web-ui/.token.')
}
const baseUrl = String(
  process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${process.env.PORT || '8648'}`,
).replace(/\/+$/, '')
const profile = String(options.profile || process.env.EKKO_PROFILE || process.env.HERMES_WEB_UI_PROFILE || '').trim()
const body = {
  mode,
  prompt,
  n,
  timeout_ms: timeoutMs,
}
for (const [option, field] of [
  ['provider', 'provider'],
  ['image-path', 'image_path'],
  ['image-url', 'image_url'],
  ['size', 'size'],
  ['quality', 'quality'],
  ['model', 'model'],
  ['image-model', 'image_model'],
  ['output-path', 'output_path'],
]) {
  if (options[option] !== undefined) body[field] = options[option]
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000)
let response
try {
  response = await fetch(`${baseUrl}/api/studio/media/apikey-image-generate`, {
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
  fail(error?.name === 'AbortError' ? 'Ekko Studio image request timed out.' : `Ekko Studio connection failed: ${error?.message || error}`)
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
  })
}
const outputPaths = Array.isArray(result.output_paths) ? result.output_paths.map(String) : []
const missingOutputs = outputPaths.filter(outputPath => !existsSync(outputPath))
if (outputPaths.length === 0 || missingOutputs.length > 0) {
  fail('Ekko Studio reported success without verifiable image output.', { output_paths: outputPaths, missing_outputs: missingOutputs })
}
console.log(JSON.stringify({ ...result, output_paths: outputPaths, output_verified: true }, null, 2))
