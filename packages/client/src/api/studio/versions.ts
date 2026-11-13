export const STUDIO_VERSION_MANIFEST_URL = 'https://api.ekkostudio.xyz/api/studio/versions'

export type AppAccessMode = 'internal' | 'public_beta' | 'paid'

export interface StudioMobileLinkChannel {
  url: string
  online: boolean
}

export interface StudioGooglePlayChannel extends StudioMobileLinkChannel {
  version: string
}

export interface StudioMobileRelease {
  /** Legacy alias for the APK version. */
  version: string
  channels: {
    androidApk: {
      version: string
      githubUrl: string
      cloudflareUrl: string
      online: boolean
    }
    googlePlay: StudioGooglePlayChannel
    apple: {
      version: string
      testFlightUrl: string
      appStoreUrl: string
      online: boolean
    }
    harmony: StudioMobileLinkChannel
  }
}

export interface StudioVersionManifest {
  schema: 1
  accessMode?: AppAccessMode
  hermes: string[]
  mobile: StudioMobileRelease
}

type StudioMobileReleaseWire = Omit<StudioMobileRelease, 'channels'> & {
  channels: {
    androidApk: Omit<StudioMobileRelease['channels']['androidApk'], 'version'> & { version?: string }
    googlePlay: Omit<StudioGooglePlayChannel, 'version'> & { version?: string }
    apple: Omit<StudioMobileRelease['channels']['apple'], 'version'> & { version?: string }
    harmony: StudioMobileLinkChannel
  }
}

type StudioVersionManifestWire = Omit<StudioVersionManifest, 'accessMode' | 'mobile'> & {
  accessMode?: unknown
  mobile: StudioMobileReleaseWire
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStudioMobileRelease(value: unknown): value is StudioMobileReleaseWire {
  if (!isRecord(value) || !isVersion(value.version) || !isRecord(value.channels)) return false
  const { androidApk, googlePlay, apple, harmony } = value.channels
  return isRecord(androidApk)
    && isOptionalVersion(androidApk.version)
    && typeof androidApk.online === 'boolean'
    && isOptionalHttpUrl(androidApk.githubUrl)
    && isOptionalHttpUrl(androidApk.cloudflareUrl)
    && isRecord(googlePlay)
    && isOptionalVersion(googlePlay.version)
    && typeof googlePlay.online === 'boolean'
    && isOptionalHttpUrl(googlePlay.url)
    && isRecord(apple)
    && isOptionalVersion(apple.version)
    && typeof apple.online === 'boolean'
    && isOptionalHttpUrl(apple.testFlightUrl)
    && isOptionalHttpUrl(apple.appStoreUrl)
    && isRecord(harmony)
    && typeof harmony.online === 'boolean'
    && isOptionalHttpUrl(harmony.url)
}

export async function fetchStudioVersionManifest(): Promise<StudioVersionManifest> {
  const response = await fetch(STUDIO_VERSION_MANIFEST_URL, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`GET ${STUDIO_VERSION_MANIFEST_URL} returned ${response.status}`)
  const manifest: unknown = await response.json()
  if (!isRecord(manifest) || manifest.schema !== 1 || !isStudioMobileRelease(manifest.mobile)) {
    throw new Error('Invalid Studio version manifest')
  }
  return normalizeStudioVersionManifest(manifest as StudioVersionManifestWire)
}

function normalizeStudioVersionManifest(manifest: StudioVersionManifestWire): StudioVersionManifest {
  const { accessMode, ...baseManifest } = manifest
  const fallbackVersion = manifest.mobile.version
  return {
    ...baseManifest,
    ...(isAppAccessMode(accessMode) ? { accessMode } : {}),
    mobile: {
      ...manifest.mobile,
      channels: {
        androidApk: {
          ...manifest.mobile.channels.androidApk,
          version: manifest.mobile.channels.androidApk.version || fallbackVersion,
        },
        googlePlay: {
          ...manifest.mobile.channels.googlePlay,
          version: manifest.mobile.channels.googlePlay.version || fallbackVersion,
        },
        apple: {
          ...manifest.mobile.channels.apple,
          version: manifest.mobile.channels.apple.version || fallbackVersion,
        },
        harmony: manifest.mobile.channels.harmony,
      },
    },
  }
}

function isAppAccessMode(value: unknown): value is AppAccessMode {
  return value === 'internal' || value === 'public_beta' || value === 'paid'
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}

function isOptionalVersion(value: unknown): value is string | undefined {
  return value === undefined || isVersion(value)
}

function isOptionalHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
