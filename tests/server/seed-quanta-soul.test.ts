import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedQuantaSoul, QUANTA_SOUL_TEMPLATE } from '../../packages/server/src/modules/hermes/services/profiles/seed-quanta-soul'

/**
 * Quanta 人格种子写入守卫：
 *  - SOUL.md 缺失 → 写入 Quanta 模板
 *  - 出厂默认模板（"You are Hermes Agent…"）→ 升级覆写
 *  - 用户自定义 soul → 绝不覆盖
 * 通过 HERMES_HOME 环境变量把 profile 目录重定向到临时目录。
 */
describe('seed-quanta-soul', () => {
  let hermesHome: string
  let prevHermesHome: string | undefined

  beforeAll(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-quanta-seed-'))
    prevHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = hermesHome
  })

  afterAll(() => {
    if (prevHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prevHermesHome
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('seeds Quanta SOUL.md when the profile has none', async () => {
    const result = await seedQuantaSoul('default')
    expect(result).toBe('seeded')
    const written = readFileSync(join(hermesHome, 'SOUL.md'), 'utf8')
    expect(written).toBe(QUANTA_SOUL_TEMPLATE)
    expect(written).toContain('Quanta')
  })

  it('upgrades a legacy factory-default SOUL.md ("You are Hermes Agent…")', async () => {
    const profileDir = join(hermesHome, 'profiles', 'legacy')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'SOUL.md'), 'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful.', 'utf8')

    const result = await seedQuantaSoul('legacy')
    expect(result).toBe('upgraded')
    expect(readFileSync(join(profileDir, 'SOUL.md'), 'utf8')).toBe(QUANTA_SOUL_TEMPLATE)
  })

  it('never touches a user-customized soul', async () => {
    const profileDir = join(hermesHome, 'profiles', 'custom')
    mkdirSync(profileDir, { recursive: true })
    const custom = '你是用户精心调教的专属人格，绝不能被覆盖。'
    writeFileSync(join(profileDir, 'SOUL.md'), custom, 'utf8')

    const result = await seedQuantaSoul('custom')
    expect(result).toBe('kept')
    expect(readFileSync(join(profileDir, 'SOUL.md'), 'utf8')).toBe(custom)
  })

  it('upgrades the default profile too when it still carries the factory template', async () => {
    // default profile 目录就是 HERMES_HOME 本身。
    writeFileSync(join(hermesHome, 'SOUL.md'), 'You are Hermes Agent, an intelligent AI assistant.', 'utf8')
    const result = await seedQuantaSoul('default')
    expect(result).toBe('upgraded')
    expect(readFileSync(join(hermesHome, 'SOUL.md'), 'utf8')).toBe(QUANTA_SOUL_TEMPLATE)
  })

  it('template is identity-stable and voice-aware', () => {
    expect(QUANTA_SOUL_TEMPLATE.startsWith("You are Quanta")).toBe(true)
    expect(QUANTA_SOUL_TEMPLATE).toContain('你是 Quanta')
    expect(QUANTA_SOUL_TEMPLATE).toContain('语音')
  })

  it('leaves the temp home clean of unexpected profiles', () => {
    expect(existsSync(join(hermesHome, 'profiles', 'ghost'))).toBe(false)
  })
})
