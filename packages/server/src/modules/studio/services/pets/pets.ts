import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getWebUiHome } from '../../public/config'
import { fetchPetdexManifest, type PetdexPet } from './petdex'

export type ActivePetState = 'idle' | 'run' | 'review' | 'failed' | 'wave' | 'jump' | 'waiting'

export interface InstalledPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  source: 'petdex'
  spritesheetUrl: string
  petJsonUrl: string
  zipUrl: string
  spritesheetFile: string
  petJsonFile?: string
  mime: string
  installedAt: number
  updatedAt: number
}

export interface ActivePetConfig {
  enabled: boolean
  slug: string
  scale: number
  position?: {
    x: number
    y: number
  }
  updatedAt: number
}

export interface ActivePetResponse {
  enabled: boolean
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  source: 'petdex'
  mime: string
  spritesheetDataUrl: string
  spritesheetRevision: number
  frameW: number
  frameH: number
  framesPerState: number
  loopMs: number
  scale: number
  position?: {
    x: number
    y: number
  }
  stateRows: string[]
  installedAt: number
  updatedAt: number
}

const FRAME_W = 192
const FRAME_H = 208
const FRAMES_PER_STATE = 6
const LOOP_MS = 1100
const DEFAULT_SCALE = 0.33
const STATE_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
]

const MAX_SPRITESHEET_BYTES = 10 * 1024 * 1024
const MAX_JSON_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 20_000

function profileMetadataRoot(): string {
  return join(getWebUiHome(), 'profile-metadata')
}

function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(profileMetadataRoot(), segment)
}

function petsRoot(profile: string): string {
  return join(profileMetadataDir(profile), 'pets')
}

function activePetPath(profile: string): string {
  return join(petsRoot(profile), 'active.json')
}

function petDir(profile: string, slug: string): string {
  return join(petsRoot(profile), safeSlug(slug))
}

function petMetaPath(profile: string, slug: string): string {
  return join(petDir(profile, slug), 'pet.json')
}

function safeSlug(slug: string): string {
  const normalized = String(slug || '').trim().toLowerCase()
  const safe = normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) throw new Error('Pet slug is required')
  return safe.slice(0, 120)
}

function assertPetdexAssetUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || (host !== 'petdex.dev' && !host.endsWith('.petdex.dev'))) {
    throw new Error('Unsupported pet asset host')
  }
  return url
}

function mimeFromResponse(response: Response, fallbackUrl: string): string {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType?.startsWith('image/')) return contentType
  if (fallbackUrl.endsWith('.webp')) return 'image/webp'
  if (fallbackUrl.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

async function fetchBytes(urlValue: string, maxBytes: number): Promise<{ buffer: Buffer; mime: string }> {
  const url = assertPetdexAssetUrl(urlValue)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'hermes-web-ui-pets' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Pet asset request failed: ${response.status}`)

    const length = Number(response.headers.get('content-length') || '0')
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error('Pet asset is too large')
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error('Pet asset is too large')
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      mime: mimeFromResponse(response, url.pathname.toLowerCase()),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchTextAsset(urlValue: string, maxBytes: number): Promise<string | null> {
  if (!urlValue) return null
  const { buffer } = await fetchBytes(urlValue, maxBytes)
  return buffer.toString('utf-8')
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

function normalizeInstalledPet(pet: PetdexPet, asset: { mime: string }, now: number): InstalledPet {
  return {
    slug: pet.slug,
    displayName: pet.displayName || pet.slug,
    kind: pet.kind || 'pet',
    submittedBy: pet.submittedBy || '',
    source: 'petdex',
    spritesheetUrl: pet.spritesheetUrl,
    petJsonUrl: pet.petJsonUrl,
    zipUrl: pet.zipUrl,
    spritesheetFile: 'spritesheet.webp',
    petJsonFile: pet.petJsonUrl ? 'petdex-pet.json' : undefined,
    mime: asset.mime,
    installedAt: now,
    updatedAt: now,
  }
}

export async function adoptPetFromPetdex(profile: string, slugInput: string): Promise<ActivePetResponse> {
  const slug = safeSlug(slugInput)
  const manifest = await fetchPetdexManifest()
  const pet = manifest.pets.find(item => safeSlug(item.slug) === slug)
  if (!pet) throw new Error(`Pet "${slugInput}" was not found in petdex`)

  const targetDir = petDir(profile, pet.slug)
  await mkdir(targetDir, { recursive: true })

  const spritesheet = await fetchBytes(pet.spritesheetUrl, MAX_SPRITESHEET_BYTES)
  await writeFile(join(targetDir, 'spritesheet.webp'), spritesheet.buffer, { mode: 0o600 })

  if (pet.petJsonUrl) {
    const petJson = await fetchTextAsset(pet.petJsonUrl, MAX_JSON_BYTES)
    if (petJson) await writeFile(join(targetDir, 'petdex-pet.json'), petJson, { encoding: 'utf-8', mode: 0o600 })
  }

  const now = Date.now()
  const installed = normalizeInstalledPet(pet, spritesheet, now)
  const active: ActivePetConfig = {
    enabled: true,
    slug: installed.slug,
    scale: DEFAULT_SCALE,
    updatedAt: now,
  }

  await writeJsonFile(petMetaPath(profile, pet.slug), installed)
  await writeJsonFile(activePetPath(profile), active)
  const response = await buildActivePetResponse(profile, installed, active)
  if (!response) throw new Error('Installed pet asset is missing')
  return response
}

export async function getActivePet(profile: string): Promise<ActivePetResponse | null> {
  const active = await readJsonFile<ActivePetConfig>(activePetPath(profile))
  if (!active?.enabled || !active.slug) return null

  const installed = await readJsonFile<InstalledPet>(petMetaPath(profile, active.slug))
  if (!installed) return null

  return buildActivePetResponse(profile, installed, active)
}

export async function updateActivePetPreferences(
  profile: string,
  input: { scale?: number; position?: { x?: number; y?: number }; enabled?: boolean },
): Promise<ActivePetResponse | null> {
  const active = await readJsonFile<ActivePetConfig>(activePetPath(profile))
  if (!active?.slug) return null

  const next: ActivePetConfig = {
    ...active,
    updatedAt: Date.now(),
  }

  if (typeof input.enabled === 'boolean') {
    next.enabled = input.enabled
  }

  if (typeof input.scale === 'number' && Number.isFinite(input.scale)) {
    next.scale = Math.min(1.2, Math.max(0.18, input.scale))
  }

  if (input.position && typeof input.position.x === 'number' && typeof input.position.y === 'number') {
    next.position = {
      x: Math.round(Math.max(0, input.position.x)),
      y: Math.round(Math.max(0, input.position.y)),
    }
  }

  await writeJsonFile(activePetPath(profile), next)
  if (!next.enabled) return null
  return getActivePet(profile)
}

async function buildActivePetResponse(
  profile: string,
  installed: InstalledPet,
  active: ActivePetConfig,
): Promise<ActivePetResponse | null> {
  const filePath = join(petDir(profile, installed.slug), installed.spritesheetFile || 'spritesheet.webp')
  if (!existsSync(filePath)) return null

  const data = await readFile(filePath)
  const spritesheetRevision = installed.updatedAt || installed.installedAt || 0
  const updatedAt = Math.max(active.updatedAt || 0, spritesheetRevision)
  return {
    enabled: active.enabled,
    slug: installed.slug,
    displayName: installed.displayName,
    kind: installed.kind,
    submittedBy: installed.submittedBy,
    source: installed.source,
    mime: installed.mime || 'image/webp',
    spritesheetDataUrl: `data:${installed.mime || 'image/webp'};base64,${data.toString('base64')}`,
    frameW: FRAME_W,
    frameH: FRAME_H,
    framesPerState: FRAMES_PER_STATE,
    loopMs: LOOP_MS,
    scale: typeof active.scale === 'number' && active.scale > 0 ? active.scale : DEFAULT_SCALE,
    position: active.position && Number.isFinite(active.position.x) && Number.isFinite(active.position.y)
      ? { x: active.position.x, y: active.position.y }
      : undefined,
    stateRows: STATE_ROWS,
    installedAt: installed.installedAt,
    spritesheetRevision,
    updatedAt,
  }
}
