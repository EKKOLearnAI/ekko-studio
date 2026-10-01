import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  pinSkill: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  getSkillUsageStatsFromDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/schemas', () => ({
  MODEL_CONTEXT_TABLE: 'model_context',
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadModelsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/models')
}

async function loadSkillsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/skills')
}

function makeCtx(body: unknown): any {
  return {
    request: { body },
    status: 200,
    body: undefined,
    query: {},
    params: {},
    state: {},
    get: vi.fn(() => ''),
  }
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

describe('config mutating controllers', () => {
  it('setConfigModel updates only the model section and preserves existing config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'terminal:',
      '  backend: local',
      'model:',
      '  default: old',
      '  provider: old-provider',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()
    const ctx = makeCtx({ default: 'glm-5.1', provider: 'custom:glm' })

    await setConfigModel(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:glm' })
    expect(config.terminal.backend).toBe('local')
  })

  it('setConfigModel keeps provider-independent keys in the model section', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: old',
      '  provider: custom:glm',
      '  context_length: 256000',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()

    await setConfigModel(makeCtx({ default: 'glm-5.1', provider: 'custom:glm' }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:glm', context_length: 256000 })
  })

  it('setConfigModel keeps the bound provider when the request omits it', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: old',
      '  provider: custom:glm',
      '  context_length: 256000',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()

    await setConfigModel(makeCtx({ default: 'glm-5.1' }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:glm', context_length: 256000 })
  })

  it('setConfigModel drops provider-scoped credentials only when the provider changes', async () => {
    const fixture = [
      'model:',
      '  default: old',
      '  provider: custom:old',
      '  context_length: 256000',
      '  base_url: http://127.0.0.1:8080/v1',
      '  api_key: sk-test',
      '',
    ].join('\n')
    const { setConfigModel } = await loadModelsController()

    await writeFile(join(hermesHome, 'config.yaml'), fixture, 'utf-8')
    await setConfigModel(makeCtx({ default: 'glm-5.1', provider: 'custom:old' }))
    let config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model.base_url).toBe('http://127.0.0.1:8080/v1')
    expect(config.model.api_key).toBe('sk-test')
    expect(config.model.context_length).toBe(256000)

    await writeFile(join(hermesHome, 'config.yaml'), fixture, 'utf-8')
    await setConfigModel(makeCtx({ default: 'glm-5.1', provider: 'custom:new' }))
    config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:new', context_length: 256000 })
  })

  it('setConfigModel preserves credentials when the existing provider is unspecified', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: old',
      '  context_length: 256000',
      '  base_url: http://127.0.0.1:8080/v1',
      '  api_key: sk-test',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()

    await setConfigModel(makeCtx({ default: 'glm-5.1', provider: 'custom:new' }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({
      default: 'glm-5.1',
      provider: 'custom:new',
      context_length: 256000,
      base_url: 'http://127.0.0.1:8080/v1',
      api_key: 'sk-test',
    })
  })

  it('setConfigModel uses the requested profile header when auth has not populated state.profile', async () => {
    const researchDir = join(hermesHome, 'profiles', 'research')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: root-model\n', 'utf-8')
    await writeFile(join(researchDir, 'config.yaml'), 'model:\n  default: old-research\n', 'utf-8')
    const { setConfigModel } = await loadModelsController()
    const ctx = makeCtx({ default: 'research-model', provider: 'deepseek' })
    ctx.get = vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'research' : '')

    await setConfigModel(ctx)

    expect(ctx.body).toEqual({ success: true })
    const rootConfig = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    const researchConfig = YAML.load(await readFile(join(researchDir, 'config.yaml'), 'utf-8')) as any
    expect(rootConfig.model.default).toBe('root-model')
    expect(researchConfig.model).toEqual({ default: 'research-model', provider: 'deepseek' })
  })

  it('skill toggle preserves unrelated config while adding and removing disabled skills', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: glm-5.1',
      'skills:',
      '  disabled:',
      '    - old-skill',
      '',
    ].join('\n'), 'utf-8')
    const { toggle } = await loadSkillsController()

    await toggle(makeCtx({ name: 'new-skill', enabled: false }))
    await toggle(makeCtx({ name: 'old-skill', enabled: true }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model.default).toBe('glm-5.1')
    expect(config.skills.disabled).toEqual(['new-skill'])
  })
})
