import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import Koa from 'koa'
import { chromium } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import { DshAgentPresetService } from '../../packages/server/src/modules/coding-agents/services/dsh/agent-presets'
import { DshManagement } from '../../packages/server/src/modules/coding-agents/services/dsh/management'
import { DshUiGateway } from '../../packages/server/src/modules/coding-agents/services/dsh/ui-gateway'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'
import { dshReleaseFixture } from '../fixtures/dsh-release'
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: async (token: string) => token === 'fixture-admin' ? { role: 'super_admin' } : null }))

it.skipIf(!process.env.DSH_WEB_COMMAND)('renders native plugin slots and submits native configuration through the mounted transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slot-real-'))
  const home = join(root, 'home'); await mkdir(join(home, 'profiles/web'), { recursive: true })
  const manifest: any = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
  if (process.env.DSH_MODLENS_PACKAGE) {
    manifest.dsh.profile.bundles.push('@liustack/modlens'); manifest.dependencies = { '@liustack/modlens': 'fixture' }
    await mkdir(join(home, 'profiles/web/node_modules/@liustack'), { recursive: true })
    await symlink(process.env.DSH_MODLENS_PACKAGE, join(home, 'profiles/web/node_modules/@liustack/modlens'), 'dir')
  }
  await mkdir(join(home, '.modlens'), { recursive: true })
  await writeFile(join(home, '.modlens/config.json'), JSON.stringify({ providers: { openai: { apiKey: 'fixture-hidden-key' } } }))
  await writeFile(join(home, 'settings.yaml'), 'ui-theme:\n  preference: dark\n')
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify(manifest))
  vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'state'))
  const management = new DshManagement({ runtimeInput: async () => ({ installationCommand: process.env.DSH_WEB_COMMAND!, sourceHome: home }), commandEnv: async () => ({ ...process.env, HOME: home, USERPROFILE: home }), commandExecution: (command, args) => ({ command, args }) })
  const gateway = new DshUiGateway(management)
  const app = new Koa(); app.use(securityHeaders()); app.use(gateway.middleware)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const detach = gateway.attach([server])
  const browser = await chromium.launch({ headless: true })
  try {
    const release = await dshReleaseFixture(process.env.DSH_WEB_COMMAND!)
    await expect(gateway.create('not-admin')).rejects.toMatchObject({ status: 403 })
    const session = await gateway.create('fixture-admin')
    const page = await browser.newPage(); const errors: string[] = []
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    page.on('console', message => { if (message.type() === 'error') console.error(message.text().slice(0,1000)) })
    await page.goto(base + session.path + '?studioTheme=light')
    const loop = page.getByRole('button', { name: /Agent loop/ })
    await loop.waitFor({ timeout: 15_000 }).catch(async error => { console.error(await page.locator('body').innerText()); throw error });
    if (release.registry) {
      const expectFilled = async () => {
        await expect.poll(() => page.locator('[data-rightbar-col]').evaluate(element => {
          const bounds = element.parentElement!.getBoundingClientRect()
          return Math.max(Math.abs(bounds.top), Math.abs(bounds.left), Math.abs(bounds.right - innerWidth), Math.abs(bounds.bottom - innerHeight))
        })).toBeLessThanOrEqual(1)
      }
      await expectFilled()
      // Current DSH owns a native Plugins panel and persists settings as profile
      // patches, rather than the legacy accordion and settings.yaml storage.
      await loop.click()
      await page.getByLabel('Parallel tool calls', { exact: true }).fill('13')
      await page.evaluate(() => window.postMessage({ type: 'studio-dsh-theme', theme: 'dark' }, location.origin))
      await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
      expect(await page.getByLabel('Parallel tool calls', { exact: true }).inputValue()).toBe('13')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const sourcePatch = join(home, 'profiles/web/cordis.patch.yml')
      await expect.poll(() => readFile(sourcePatch, 'utf8')).toContain('maxParallelToolCalls: 13')
      await page.getByRole('button', { name: 'Save', exact: true }).waitFor()
      expect(await page.locator('[data-rightbar-col]').evaluate(element => getComputedStyle(element.parentElement!).gridTemplateColumns.split(' ')[0])).toBe('0px')
      await page.screenshot({ path: '/tmp/dsh-registry-settings-desktop.png' })
      await page.setViewportSize({ width: 390, height: 844 })
      await expectFilled()
      await page.screenshot({ path: '/tmp/dsh-registry-settings-mobile.png' })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.setViewportSize({ width: 740, height: 390 })
      await expectFilled()
      const save = page.getByRole('button', { name: 'Save', exact: true })
      await save.scrollIntoViewIfNeeded()
      expect(await save.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight })).toBe(true)
      const presets = new DshAgentPresetService(management)
      expect(await presets.list()).toMatchObject({ authorable: false, presets: expect.arrayContaining([expect.objectContaining({ id: 'standard', isDefault: true })]) })
      expect((await presets.read('standard')).content).toContain('name:')
      await presets.makeDefault('minimal')
      expect(await readFile(sourcePatch, 'utf8')).toContain('selectedDefault: minimal')
      await page.close(); await management.close()
      expect((await presets.list()).presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'minimal', isDefault: true })]))
      expect(await readFile(sourcePatch, 'utf8')).toContain('maxParallelToolCalls: 13')
      expect(await readFile(sourcePatch, 'utf8')).not.toContain('studio-dark')
      expect(errors).toEqual([])
      gateway.remove(session.id, 'fixture-admin')
      return
    }
    expect(await loop.evaluate(element => getComputedStyle(element, '::after').content)).toContain('settings')
    await loop.click()
    const card = page.locator('li').filter({ has: page.getByRole('button', { name: /Agent loop/ }) })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    const lightColor = await loop.evaluate(element => getComputedStyle(element).color)
    await card.getByLabel('Parallel tool calls', { exact: true }).fill('13')
    await page.evaluate(() => window.postMessage({ type: 'studio-dsh-theme', theme: 'dark' }, location.origin))
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
    expect(await loop.evaluate(element => getComputedStyle(element).color)).not.toBe(lightColor)
    expect(await card.getByLabel('Parallel tool calls', { exact: true }).inputValue()).toBe('13')
    await page.screenshot({ path: '/tmp/dsh-slot-theme-dark.png', animations: 'disabled' })
    expect(await card.evaluate(element => Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[0]))).toBeLessThan(128)
    await page.evaluate(() => window.postMessage({ type: 'studio-dsh-theme', theme: 'light' }, location.origin))
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'studio-dsh-theme', theme: 'dark' }, origin: 'https://untrusted.invalid', source: window })))
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('light')
    await page.screenshot({ path: '/tmp/dsh-slot-theme-light.png', animations: 'disabled' })
    expect(await card.evaluate(element => Number(getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[0]))).toBeGreaterThan(128)
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFile(join(home, 'settings.yaml'), 'utf8')).toContain('maxParallelToolCalls: 13')
    expect(await page.getByText('Session plugins', { exact: true }).count()).toBe(0)
    if (process.env.DSH_MODLENS_PACKAGE) {
      await page.getByRole('button', { name: /Vision engine \(ModLens\)/ }).click()
      const engine = page.getByRole('combobox').first()
      await engine.selectOption('openai')
      await page.getByLabel('Base URL', { exact: true }).fill('https://fixture.invalid/v1')
      await page.getByLabel('Model', { exact: true }).fill('fixture-vision')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(async () => JSON.parse(await readFile(join(home, '.modlens/config.json'), 'utf8'))).toMatchObject({ provider: 'openai', providers: { openai: { model: 'fixture-vision', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-hidden-key' } } })
      expect(await page.locator('body').innerText()).not.toContain('fixture-hidden-key')
      await engine.selectOption('claude-cli')
      expect(await page.getByLabel('Base URL', { exact: true }).count()).toBe(0)
      expect(await page.getByText('This engine signs in through its own CLI: no key, no endpoint.').count()).toBe(1)
    }
    await page.screenshot({ path: '/tmp/dsh-native-slot-real.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: '/tmp/dsh-native-slot-mobile.png' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const presets = new DshAgentPresetService(management)
    expect((await presets.list()).presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'standard', isDefault: true })]))
    const source = await presets.read('standard')
    expect(source.content).toContain('name:')
    await presets.copy({ from: 'standard', id: 'fixture-copy', name: 'Fixture copy' })
    expect(await readFile(join(home, '.agent-presets/fixture-copy/agent.cordis.yml'), 'utf8')).toBe(source.content)
    await presets.makeDefault('fixture-copy')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('default: fixture-copy')
    await expect(presets.remove('standard')).rejects.toMatchObject({ status: 403 })
    await page.close()
    await management.close()
    expect((await presets.list()).presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fixture-copy', isDefault: true, name: 'Fixture copy' })]))
    expect((await presets.remove('fixture-copy')).presets.some(row => row.id === 'fixture-copy')).toBe(false)
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).not.toContain('default: fixture-copy')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('preference: dark')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).not.toContain('studio-light')
    expect(errors).toEqual([])
    gateway.remove(session.id, 'fixture-admin')
    expect((await fetch(base + session.path)).status).toBe(401)
  } finally {
    await browser.close(); detach(); await management.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
  }
}, 90_000)
