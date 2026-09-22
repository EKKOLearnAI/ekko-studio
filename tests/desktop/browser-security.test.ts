import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'
import { isAllowedBrowserRequest, isAllowedBrowserSubresource, normalizeBrowserUrl, publicBrowserUrl, redactBrowserContent, redactBrowserText } from '../../packages/desktop/src/main/browser/browser-url'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop browser security primitives', () => {
  it('keeps numbered marks for a multi-selection annotation session', async () => {
    const source = await readFile('packages/desktop/src/main/browser/browser-manager.ts', 'utf8')
    expect(source).toContain("box.setAttribute('data-hermes-browser-annotation-mark', String(marker))")
    expect(source).toContain("host.attachShadow({ mode:'closed' })")
    expect(source).toContain("top:'calc(100% + 4px)'")
    expect(source).toContain('mark.target.getBoundingClientRect()')
    expect(source).toContain('mark.documentRegion.x-scrollX')
    expect(source).toContain('const track = () => { refresh(); refreshFrame=requestAnimationFrame(track); }')
    expect(source).toContain('if(refreshFrame)cancelAnimationFrame(refreshFrame)')
    expect(source).toContain('this.annotationMarkerCounts.set(tabId, marker)')
    expect(source).toContain('async updateAnnotationNote(tabId: string, marker: number, note: string)')
    expect(source).toContain('async captureAnnotations(tabId: string)')
    expect(source).toContain('screenshot: whole')
    expect(source).toContain('await this.clearAnnotations(tabId, false)')
    expect(source).toContain('async clearAnnotations(tabId: string, waitForPage = true)')
    expect(source).toContain('if (!wasActive && !hadMarks) return false')
    expect(source).not.toContain('const cropped = image.crop')
  })

  it('allows normal web pages but blocks privileged schemes, credentials, and metadata endpoints', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrl('about:blank', { allowBlank: true })).toBe('about:blank')
    expect(() => normalizeBrowserUrl('file:///etc/passwd')).toThrow(/HTTP and HTTPS/)
    expect(() => normalizeBrowserUrl('https://user:secret@example.com')).toThrow(/credentials/)
    expect(() => normalizeBrowserUrl('http://169.254.169.254/latest/meta-data')).toThrow(/blocked/)
    expect(isAllowedBrowserRequest('javascript:alert(1)')).toBe(false)
    expect(isAllowedBrowserSubresource('data:image/png;base64,AA==')).toBe(true)
    expect(isAllowedBrowserSubresource('file:///tmp/secret')).toBe(false)
    expect(publicBrowserUrl('https://example.com/callback?code=secret-code&view=ok#access_token=secret')).toBe('https://example.com/callback?code=%5Bredacted%5D&view=ok#[redacted]')
    expect(redactBrowserText('Authorization: Bearer very.secret.token')).toBe('Authorization: Bearer [redacted]')
    expect(redactBrowserContent('first line\napi_key=secret-value\nlast line', 100)).toBe('first line\napi_key=[redacted]\nlast line')
  })

  it('applies profile storage and proxy changes before restored tabs load', async () => {
    const source = await readFile('packages/desktop/src/main/browser/browser-manager.ts', 'utf8')
    expect(source).toContain('const record = await this.buildTab(profile, normalizedUrl)')
    expect(source).toContain('await this.configureSession(profile, browserSession)')
    expect(source).toContain('await browserSession.setProxy(proxy)')
    expect(source).toContain('this.destroyViews()')
    expect(source).toContain('await this.restoreTabs(profile)')
    expect(source).toContain('private readonly browserSessions = new Map<string, Session>()')
    expect(source).toContain('await this.flushProfileSession(this.requireProfile(this.activeProfileId))')
    expect(source).toContain('browserSession.flushStorageData()')
    expect(source).toContain('await browserSession.cookies.flushStore()')
    expect(source).toContain('const browserSession = this.profileSession(profile)')
    expect(source).toContain('browserSession.isPersistent()')
    expect(source).toContain('browserSession.getStoragePath()')
    expect(source).toContain("browserSession.cookies.on('changed', listener)")
    expect(source).toContain('await this.persistSessionCookies(profile, browserSession)')
    expect(source).toContain('browser session shutdown exceeded')
    expect(source).not.toContain('safeStorage')
    expect(source).toContain('BrowserSessionCookieStore')
    expect(source).toContain('cancelDownload(downloadId: string)')
    expect(source).toContain('this.downloadItems.set(download.id, item)')
    expect(source).toContain('item.cancel()')
    expect(source).toContain('item.setSaveDialogOptions({ defaultPath: savePath })')
    expect(source).toContain('else item.setSavePath(savePath)')
    expect(source).toContain('if (!this.downloadItems.has(download.id)) return')
    expect(source).not.toContain('item.pause()')
    expect(source).not.toContain('dialog.showSaveDialog(this.window')
    expect(source).toContain('async createHtmlPreviewTab(html: string, title: string')
    expect(source).toContain('if (size > HTML_PREVIEW_MAX_BYTES)')
    expect(source).toContain('record.ephemeral = true')
    expect(source).toContain("filter(record => !record.ephemeral)")
    expect(source).toContain("record.tab.url = isHtmlPreview ? 'about:blank' : currentUrl")
  })

  it('persists owner-only isolated profile roots and rejects overlapping or non-empty directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-profile-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const store = new BrowserProfileStore(stateRoot)
    await store.initialize()
    const first = store.active()
    const secondRoot = join(root, 'work-profile')
    await mkdir(secondRoot)
    const canonicalSecondRoot = await realpath(secondRoot)
    const second = await store.create({
      name: 'Work',
      rootDirectory: secondRoot,
      proxyMode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
    })

    expect(first.id).not.toBe(second.id)
    expect(first.rootPath).toBe(join(stateRoot, 'profiles', first.id))
    expect(first.sessionPath).toBe(join(first.rootPath, 'data'))
    expect(first.downloadPath).toBe(join(first.rootPath, 'download'))
    expect(first.sessionPath).not.toBe(second.sessionPath)
    expect(second.rootPath).toBe(canonicalSecondRoot)
    expect(second.sessionPath).toBe(join(canonicalSecondRoot, 'data'))
    expect(second.downloadPath).toBe(join(canonicalSecondRoot, 'download'))
    expect((await stat(second.sessionPath)).isDirectory()).toBe(true)
    expect((await stat(second.downloadPath)).isDirectory()).toBe(true)
    expect(second.proxyMode).toBe('fixed_servers')
    expect(second.proxyRules).toBe('http://127.0.0.1:7890')
    await expect(store.update(second.id, { rootDirectory: first.rootPath })).rejects.toThrow(/overlap/)
    await expect(store.update(second.id, { rootDirectory: process.platform === 'win32' ? 'C:\\' : '/' })).rejects.toThrow(/filesystem root/)

    const nonEmpty = join(root, 'non-empty')
    await mkdir(nonEmpty, { recursive: true })
    await writeFile(join(nonEmpty, 'keep.txt'), 'do not remove')
    await expect(store.update(second.id, { rootDirectory: nonEmpty })).rejects.toThrow(/must be empty/)

    const document = JSON.parse(await readFile(join(stateRoot, 'profiles.json'), 'utf8'))
    expect(document.schema).toBe(1)
    if (process.platform !== 'win32') expect((await stat(join(stateRoot, 'profiles.json'))).mode & 0o077).toBe(0)
  })

  it('persists an empty tab list after the final browser tab is closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-empty-tabs-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const store = new BrowserProfileStore(stateRoot)
    await store.initialize()
    await store.setTabs(store.active().id, [])

    const restarted = new BrowserProfileStore(stateRoot)
    await restarted.initialize()

    expect(restarted.active().tabs).toEqual([])
  })

  it('uses the system proxy for a newly initialized default profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-system-proxy-'))
    roots.push(root)
    const store = new BrowserProfileStore(join(root, 'state'))

    await store.initialize()

    expect(store.active().proxyMode).toBe('system')
    expect(store.active().proxyRules).toBe('')
  })

  it('switches to a new empty root without migrating old browser data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-browser-profile-switch-'))
    roots.push(root)
    const stateRoot = join(root, 'state')
    const store = new BrowserProfileStore(stateRoot)
    await store.initialize()
    const profile = store.active()
    const oldSessionPath = profile.sessionPath
    await writeFile(join(profile.sessionPath, 'cookie-state'), 'persisted')
    const destination = join(root, 'custom-profile')
    await mkdir(destination)
    const canonicalDestination = await realpath(destination)
    const updated = await store.update(profile.id, {
      rootDirectory: destination,
      proxyMode: 'system',
    })

    expect(updated.rootPath).toBe(canonicalDestination)
    expect(updated.sessionPath).toBe(join(canonicalDestination, 'data'))
    expect(updated.downloadPath).toBe(join(canonicalDestination, 'download'))
    expect(updated.proxyMode).toBe('system')
    expect((await stat(updated.sessionPath)).isDirectory()).toBe(true)
    expect((await stat(updated.downloadPath)).isDirectory()).toBe(true)
    expect(await readFile(join(oldSessionPath, 'cookie-state'), 'utf8')).toBe('persisted')
    await expect(readFile(join(updated.sessionPath, 'cookie-state'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
