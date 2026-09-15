import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { BrowserProfileCreateInput, BrowserProfileUpdateInput, BrowserProxyMode, DesktopBrowserProfile } from './browser-types'

interface BrowserProfilesDocument {
  schema: 1
  activeProfileId: string
  profiles: DesktopBrowserProfile[]
}

function now(): string {
  return new Date().toISOString()
}

function isPathWithin(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeName(input: string): string {
  const name = String(input || '').trim().replace(/[\u0000-\u001f]/g, '')
  if (!name) throw new Error('Profile name is required')
  if (name.length > 80) throw new Error('Profile name is too long')
  return name
}

function safeProxyMode(input: unknown): BrowserProxyMode {
  return input === 'system' || input === 'fixed_servers' ? input : 'direct'
}

function safeProxyRules(input: unknown, mode: BrowserProxyMode): string {
  const rules = String(input || '').trim().replace(/[\u0000-\u001f]/g, '')
  if (rules.length > 2_048) throw new Error('Proxy rules are too long')
  if (mode === 'fixed_servers' && !rules) throw new Error('Proxy server is required')
  return mode === 'fixed_servers' ? rules : ''
}

export class BrowserProfileStore {
  readonly root: string
  readonly profilesFile: string
  private document: BrowserProfilesDocument | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.root = resolve(root)
    this.profilesFile = join(this.root, 'profiles.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    await mkdir(join(this.root, 'profiles'), { recursive: true, mode: 0o700 })
    await chmod(join(this.root, 'profiles'), 0o700)
    this.document = await this.readDocument()
    for (const profile of this.document.profiles) {
      await mkdir(profile.sessionPath, { recursive: true, mode: 0o700 })
      await mkdir(profile.downloadPath, { recursive: true, mode: 0o700 })
    }
    await this.persist()
  }

  list(): DesktopBrowserProfile[] {
    return this.requireDocument().profiles.map(profile => ({ ...profile, tabs: [...profile.tabs] }))
  }

  active(): DesktopBrowserProfile {
    const document = this.requireDocument()
    return this.get(document.activeProfileId) || document.profiles[0]
  }

  get(profileId: string): DesktopBrowserProfile | undefined {
    return this.requireDocument().profiles.find(profile => profile.id === profileId)
  }

  async create(input: BrowserProfileCreateInput): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    const profileName = safeName(input.name)
    const profileRoot = await this.validateProfileRoot(input.rootDirectory)
    const proxyMode = input.proxyMode === undefined ? 'system' : safeProxyMode(input.proxyMode)
    const proxyRules = safeProxyRules(input.proxyRules, proxyMode)
    const id = randomUUID()
    const createdAt = now()
    const profile: DesktopBrowserProfile = {
      id,
      name: profileName,
      rootPath: profileRoot,
      sessionPath: join(profileRoot, 'data'),
      downloadPath: join(profileRoot, 'download'),
      proxyMode,
      proxyRules,
      askBeforeDownload: true,
      downloadConflictPolicy: 'uniquify',
      createdAt,
      lastUsedAt: createdAt,
      tabs: ['about:blank'],
    }
    await mkdir(profile.sessionPath, { recursive: true, mode: 0o700 })
    await mkdir(profile.downloadPath, { recursive: true, mode: 0o700 })
    document.profiles.push(profile)
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async renameProfile(profileId: string, name: string): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    profile.name = safeName(name)
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async setActive(profileId: string): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    const profile = this.requireProfile(profileId)
    document.activeProfileId = profileId
    profile.lastUsedAt = now()
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async setTabs(profileId: string, tabs: string[]): Promise<void> {
    const profile = this.requireProfile(profileId)
    profile.tabs = tabs.slice(0, 8).map(url => String(url || 'about:blank'))
    await this.persist()
  }

  async update(profileId: string, input: BrowserProfileUpdateInput): Promise<DesktopBrowserProfile> {
    const profile = this.requireProfile(profileId)
    const proxyMode = input.proxyMode === undefined ? profile.proxyMode : safeProxyMode(input.proxyMode)
    const proxyRules = input.proxyRules === undefined && proxyMode === profile.proxyMode
      ? profile.proxyRules
      : safeProxyRules(input.proxyRules, proxyMode)
    const requestedRoot = String(input.rootDirectory || profile.rootPath).trim()
    let profileRoot = profile.rootPath
    if (resolve(requestedRoot) !== resolve(profile.rootPath)) {
      profileRoot = await this.validateProfileRoot(requestedRoot, profileId)
      await mkdir(join(profileRoot, 'data'), { recursive: true, mode: 0o700 })
      await mkdir(join(profileRoot, 'download'), { recursive: true, mode: 0o700 })
      profile.rootPath = profileRoot
      profile.sessionPath = join(profileRoot, 'data')
      profile.downloadPath = join(profileRoot, 'download')
    }
    profile.proxyMode = proxyMode
    profile.proxyRules = proxyRules
    if (typeof input.askBeforeDownload === 'boolean') profile.askBeforeDownload = input.askBeforeDownload
    if (input.downloadConflictPolicy === 'ask' || input.downloadConflictPolicy === 'uniquify') {
      profile.downloadConflictPolicy = input.downloadConflictPolicy
    }
    await this.persist()
    return { ...profile, tabs: [...profile.tabs] }
  }

  async deleteProfile(profileId: string): Promise<DesktopBrowserProfile> {
    const document = this.requireDocument()
    if (document.profiles.length <= 1) throw new Error('At least one browser profile is required')
    const index = document.profiles.findIndex(profile => profile.id === profileId)
    if (index < 0) throw new Error('Browser profile not found')
    const [removed] = document.profiles.splice(index, 1)
    if (document.activeProfileId === profileId) document.activeProfileId = document.profiles[0].id
    await this.persist()
    return removed
  }

  private async readDocument(): Promise<BrowserProfilesDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.profilesFile, 'utf8')) as BrowserProfilesDocument
      if (parsed?.schema === 1 && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        parsed.profiles = parsed.profiles.map((profile) => {
          const rootPath = resolve(String(profile.rootPath || dirname(profile.sessionPath)))
          const proxyMode = safeProxyMode(profile.proxyMode)
          return {
            ...profile,
            rootPath,
            sessionPath: join(rootPath, 'data'),
            downloadPath: join(rootPath, 'download'),
            proxyMode,
            proxyRules: safeProxyRules(profile.proxyRules, proxyMode),
            tabs: Array.isArray(profile.tabs) ? profile.tabs : ['about:blank'],
          }
        })
        if (!parsed.profiles.some(profile => profile.id === parsed.activeProfileId)) parsed.activeProfileId = parsed.profiles[0].id
        return parsed
      }
    } catch {
      // Create the first managed profile below.
    }
    const id = randomUUID()
    const createdAt = now()
    return {
      schema: 1,
      activeProfileId: id,
      profiles: [{
        id,
        name: 'Default',
        rootPath: join(this.root, 'profiles', id),
        sessionPath: join(this.root, 'profiles', id, 'data'),
        downloadPath: join(this.root, 'profiles', id, 'download'),
        proxyMode: 'system',
        proxyRules: '',
        askBeforeDownload: true,
        downloadConflictPolicy: 'uniquify',
        createdAt,
        lastUsedAt: createdAt,
        tabs: ['about:blank'],
      }],
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistQueue.catch(() => undefined).then(async () => {
      const tempPath = `${this.profilesFile}.${process.pid}.tmp`
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await writeFile(tempPath, `${JSON.stringify(this.requireDocument(), null, 2)}\n`, { mode: 0o600 })
      await rename(tempPath, this.profilesFile)
      await chmod(this.profilesFile, 0o600)
    })
    this.persistQueue = write
    await write
  }

  private requireDocument(): BrowserProfilesDocument {
    if (!this.document) throw new Error('Browser profile store is not initialized')
    return this.document
  }

  private requireProfile(profileId: string): DesktopBrowserProfile {
    const profile = this.get(profileId)
    if (!profile) throw new Error('Browser profile not found')
    return profile
  }

  private async validateProfileRoot(pathname: string, excludedProfileId?: string): Promise<string> {
    const input = String(pathname || '').trim()
    if (!isAbsolute(input)) throw new Error('Profile root directory must be an absolute path')
    const requested = resolve(input)
    let normalized: string
    try {
      const info = await stat(requested)
      if (!info.isDirectory()) throw new Error('Selected profile path is not a directory')
      normalized = await realpath(requested)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Selected profile directory does not exist')
      throw error
    }
    if (dirname(normalized) === normalized) throw new Error('A filesystem root cannot be used as a browser profile directory')
    const browserRoot = await realpath(this.root).catch(() => this.root)
    if (isPathWithin(normalized, browserRoot) || isPathWithin(browserRoot, normalized)) {
      throw new Error('The selected profile directory cannot overlap the browser data root')
    }
    for (const profile of this.requireDocument().profiles) {
      if (profile.id === excludedProfileId) continue
      const otherRoot = await realpath(profile.rootPath).catch(() => profile.rootPath)
      if (isPathWithin(normalized, otherRoot) || isPathWithin(otherRoot, normalized)) {
        throw new Error('Browser profile directories cannot overlap')
      }
    }
    if ((await readdir(normalized)).length > 0) throw new Error('The selected profile directory must be empty')

    return normalized
  }
}
