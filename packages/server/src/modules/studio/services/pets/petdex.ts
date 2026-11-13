export interface PetdexPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  spritesheetUrl: string
  previewUrl?: string
  petJsonUrl: string
  zipUrl: string
}

export interface PetdexManifest {
  generatedAt: string
  total: number
  pets: PetdexPet[]
}

const PETDEX_MANIFEST_URL = 'https://assets.petdex.dev/manifests/petdex-v1.json'
const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
const MAX_ASSET_BYTES = 10 * 1024 * 1024

let cache: { expiresAt: number; manifest: PetdexManifest } | null = null

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizePet(value: unknown): PetdexPet | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const slug = asString(item.slug).trim()
  const spritesheetUrl = asString(item.spritesheetUrl).trim()
  if (!slug || !spritesheetUrl) return null
  return {
    slug,
    displayName: asString(item.displayName).trim() || slug,
    kind: asString(item.kind).trim() || 'pet',
    submittedBy: asString(item.submittedBy).trim(),
    spritesheetUrl,
    previewUrl: `/api/studio/petdex/asset?url=${encodeURIComponent(spritesheetUrl)}`,
    petJsonUrl: asString(item.petJsonUrl).trim(),
    zipUrl: asString(item.zipUrl).trim(),
  }
}

function assertPetdexAssetUrl(value: string): URL {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || (host !== 'petdex.dev' && !host.endsWith('.petdex.dev'))) {
    throw new Error('Unsupported petdex asset host')
  }
  return url
}

function imageMimeFromResponse(response: Response, pathname: string): string {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType?.startsWith('image/')) return contentType
  const lower = pathname.toLowerCase()
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

function normalizeManifest(value: unknown): PetdexManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('petdex manifest is not an object')
  }

  const data = value as Record<string, unknown>
  const pets = Array.isArray(data.pets) ? data.pets.map(normalizePet).filter((pet): pet is PetdexPet => Boolean(pet)) : []
  if (pets.length === 0) {
    throw new Error('petdex manifest has no pets')
  }

  return {
    generatedAt: asString(data.generatedAt),
    total: typeof data.total === 'number' ? data.total : pets.length,
    pets,
  }
}

export async function fetchPetdexManifest(options: { force?: boolean } = {}): Promise<PetdexManifest> {
  const now = Date.now()
  if (!options.force && cache && cache.expiresAt > now) {
    return cache.manifest
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(PETDEX_MANIFEST_URL, {
      headers: { 'User-Agent': 'hermes-web-ui-petdex' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`petdex manifest request failed: ${response.status}`)
    }
    const manifest = normalizeManifest(await response.json())
    cache = { expiresAt: now + CACHE_TTL_MS, manifest }
    return manifest
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchPetdexAsset(urlValue: string): Promise<{ buffer: Buffer; mime: string; maxAgeSeconds: number }> {
  const url = assertPetdexAssetUrl(urlValue)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'hermes-web-ui-petdex' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`petdex asset request failed: ${response.status}`)

    const length = Number(response.headers.get('content-length') || '0')
    if (Number.isFinite(length) && length > MAX_ASSET_BYTES) {
      throw new Error('petdex asset is too large')
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_ASSET_BYTES) {
      throw new Error('petdex asset is too large')
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      mime: imageMimeFromResponse(response, url.pathname),
      maxAgeSeconds: 60 * 60,
    }
  } finally {
    clearTimeout(timeout)
  }
}
