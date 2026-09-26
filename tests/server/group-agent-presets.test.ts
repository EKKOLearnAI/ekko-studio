import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hermes-group-agent-presets-'))
process.env.HERMES_WEB_UI_TEST_DB_DIR = join(root, 'db')
process.env.HERMES_WEB_UI_HOME = join(root, 'home')
process.env.HERMES_WEBUI_STATE_DIR = join(root, 'home')

const modelGroups = vi.hoisted(() => ({
  value: [{ provider: 'openai', models: ['gpt-test', 'gpt-new'] }] as Array<{
    provider: string
    models: string[]
    model_meta?: Record<string, { disabled?: boolean }>
  }>,
}))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({
  getGroupAvailableModelGroups: vi.fn(async () => modelGroups.value),
}))

beforeEach(async () => {
  const { resetAgentStatusRegistryForTests, updateAgentStatus } = await import(
    '../../packages/server/src/modules/studio/public/agent-status-registry'
  )
  resetAgentStatusRegistryForTests()
  updateAgentStatus('codex', {
    installed: true,
    source: 'user-cli',
    path: '/usr/local/bin/codex',
  })
})

afterAll(async () => {
  const { resetAgentStatusRegistryForTests } = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
  resetAgentStatusRegistryForTests()
  const { closeDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('group Agent presets', () => {
  it('returns an application conflict for owner-scoped duplicate names without leaking SQLite details', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const controller = await import('../../packages/server/src/modules/studio/controllers/group-agent-presets')
    initAllStores()
    modelGroups.value = [{ provider: 'openai', models: ['gpt-test'] }]

    const input = {
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Duplicate Reviewer',
      description: '',
      avatar: '',
    }
    const user = { id: 70, role: 'admin', profiles: ['research'] }
    const firstCreateCtx: any = { state: { user }, request: { body: input } }
    await controller.create(firstCreateCtx)
    expect(firstCreateCtx.status).toBe(201)

    const duplicateCreateCtx: any = { state: { user }, request: { body: input } }
    await controller.create(duplicateCreateCtx)
    expect(duplicateCreateCtx).toMatchObject({
      status: 409,
      body: {
        code: 'GROUP_AGENT_PRESET_NAME_CONFLICT',
        error: 'Agent preset already exists',
      },
    })
    expect(JSON.stringify(duplicateCreateCtx.body)).not.toMatch(/sqlite|gc_agent_presets|ownerUserId/i)

    const otherOwnerCtx: any = {
      state: { user: { ...user, id: 71 } },
      request: { body: input },
    }
    await controller.create(otherOwnerCtx)
    expect(otherOwnerCtx.status).toBe(201)

    const secondCreateCtx: any = {
      state: { user },
      request: { body: { ...input, name: 'Second Reviewer' } },
    }
    await controller.create(secondCreateCtx)
    expect(secondCreateCtx.status).toBe(201)

    const duplicateRenameCtx: any = {
      state: { user },
      params: { presetId: secondCreateCtx.body.preset.id },
      request: { body: input },
    }
    await controller.update(duplicateRenameCtx)
    expect(duplicateRenameCtx).toMatchObject({
      status: 409,
      body: {
        code: 'GROUP_AGENT_PRESET_NAME_CONFLICT',
        error: 'Agent preset already exists',
      },
    })
    expect(JSON.stringify(duplicateRenameCtx.body)).not.toMatch(/sqlite|gc_agent_presets|ownerUserId/i)
  })

  it('persists owner-scoped CRUD snapshots without secret fields', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const {
      createGroupAgentPreset,
      deleteGroupAgentPreset,
      getGroupAgentPreset,
      listGroupAgentPresets,
      updateGroupAgentPreset,
    } = await import('../../packages/server/src/modules/studio/repositories/group-agent-preset-store')
    initAllStores()

    const created = createGroupAgentPreset({
      ownerUserId: 7,
      agent: 'dsh',
      agentPreset: 'minimal',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: 'Reviews pull requests',
      avatar: '',
    })

    expect(listGroupAgentPresets(7)).toEqual([created])
    expect(listGroupAgentPresets(8)).toEqual([])
    expect(getGroupAgentPreset(created.id, 8)).toBeNull()

    const updated = updateGroupAgentPreset(created.id, 7, {
      ...created,
      model: 'gpt-new',
      description: 'Updated definition',
    })
    expect(updated).toMatchObject({ model: 'gpt-new', description: 'Updated definition' })
    expect(deleteGroupAgentPreset(created.id, 8)).toBe(false)
    expect(deleteGroupAgentPreset(created.id, 7)).toBe(true)
  })

  it('rejects secrets and unavailable profile/provider/model references', async () => {
    const {
      normalizeGroupAgentPresetInput,
      validateGroupAgentPresetCapability,
    } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-presets')

    expect(() => normalizeGroupAgentPresetInput({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      name: 'Reviewer',
      apiKey: 'secret',
    })).toThrow(/unsupported or secret fields/i)

    const preset = normalizeGroupAgentPresetInput({
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: '',
      avatar: '',
    })
    expect(() => validateGroupAgentPresetCapability(preset, [
      { provider: 'openai', models: ['gpt-other'] },
    ])).toThrow(/unavailable/i)
    expect(() => validateGroupAgentPresetCapability(preset, [
      { provider: 'openai', models: ['gpt-test'] },
    ])).not.toThrow()
    expect(() => validateGroupAgentPresetCapability(preset, [{
      provider: 'openai',
      models: ['gpt-test'],
      model_meta: { 'gpt-test': { disabled: true } },
    }])).toThrow(/unavailable/i)
  })

  it('normalizes global CLI presets without persisting scoped model configuration', async () => {
    const {
      normalizeGroupAgentPresetInput,
      validateGroupAgentPresetCapability,
    } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-presets')

    const preset = normalizeGroupAgentPresetInput({
      agent: 'codex',
      agentMode: 'global',
      profile: 'research',
      provider: 'must-not-persist',
      model: 'must-not-persist',
      apiMode: 'chat_completions',
      reasoningEffort: 'high',
      name: 'Global Reviewer',
      description: '',
      avatar: '',
    })
    expect(preset).toMatchObject({
      agent: 'codex',
      agentMode: 'global',
      provider: '',
      model: '',
      apiMode: '',
      reasoningEffort: '',
    })
    expect(() => validateGroupAgentPresetCapability(preset, [])).not.toThrow()
    expect(() => normalizeGroupAgentPresetInput({
      ...preset,
      agent: 'ekko',
      name: 'Invalid Global Ekko',
    })).toThrow(/global mode is only available/i)
  })

  it('marks presets unavailable when their Agent is not installed', async () => {
    const controller = await import('../../packages/server/src/modules/studio/controllers/group-agent-presets')
    const { updateAgentStatus } = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    modelGroups.value = [{ provider: 'openai', models: ['gpt-test'] }]
    const user = { id: 901, role: 'admin', profiles: ['research'] }
    const input = {
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Availability Reviewer',
      description: '',
      avatar: '',
    }
    const createCtx: any = { state: { user }, request: { body: input } }
    await controller.create(createCtx)
    expect(createCtx.status).toBe(201)

    updateAgentStatus('codex', {
      installed: false,
      source: 'not-installed',
      path: '',
      version: '',
    })

    const listCtx: any = { state: { user }, query: {} }
    await controller.list(listCtx)
    expect(listCtx.body.presets).toEqual([
      expect.objectContaining({
        id: createCtx.body.preset.id,
        available: false,
        validationError: 'Codex is not installed',
      }),
    ])
    await expect(controller.resolveGroupAgentPresetForApplication(user, createCtx.body.preset.id))
      .rejects.toMatchObject({ status: 409, code: 'AGENT_NOT_INSTALLED', agent: 'codex' })
  })

  it('enforces owner/profile boundaries and fail-closes disabled models across CRUD and application', async () => {
    const controller = await import('../../packages/server/src/modules/studio/controllers/group-agent-presets')
    modelGroups.value = [{ provider: 'openai', models: ['gpt-test', 'gpt-new'] }]
    const createCtx: any = {
      state: { user: { id: 41, role: 'admin', profiles: ['research'] } },
      request: { body: {
        agent: 'codex',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        reasoningEffort: 'high',
        name: 'Reviewer API',
        description: '',
        avatar: '',
      } },
    }
    await controller.create(createCtx)
    expect(createCtx.status).toBe(201)
    const presetId = createCtx.body.preset.id

    const enabledUpdateCtx: any = {
      state: createCtx.state,
      params: { presetId },
      request: { body: { ...createCtx.request.body, model: 'gpt-new' } },
    }
    await controller.update(enabledUpdateCtx)
    expect(enabledUpdateCtx.body.preset).toMatchObject({ model: 'gpt-new', available: true })

    const enabledListCtx: any = { state: createCtx.state, query: {} }
    await controller.list(enabledListCtx)
    expect(enabledListCtx.body.presets).toEqual([
      expect.objectContaining({ id: presetId, model: 'gpt-new', available: true, validationError: '' }),
    ])

    const snapshot = await controller.resolveGroupAgentPresetForApplication(createCtx.state.user, presetId)
    expect(snapshot).toMatchObject({ name: 'Reviewer API', model: 'gpt-new' })
    await expect(controller.resolveGroupAgentPresetForApplication(
      { id: 42, role: 'admin', profiles: ['research'] },
      presetId,
    )).rejects.toMatchObject({ status: 404 })

    const deniedCtx: any = {
      state: { user: { id: 41, role: 'admin', profiles: ['default'] } },
      request: { body: createCtx.request.body },
    }
    await controller.create(deniedCtx)
    expect(deniedCtx.status).toBe(403)

    const enabledResetCtx: any = {
      state: createCtx.state,
      params: { presetId },
      request: { body: createCtx.request.body },
    }
    await controller.update(enabledResetCtx)
    expect(enabledResetCtx.body.preset).toMatchObject({ model: 'gpt-test', available: true })

    modelGroups.value = [{
      provider: 'openai',
      models: ['gpt-test', 'gpt-new'],
      model_meta: { 'gpt-new': { disabled: true } },
    }]

    const disabledCreateCtx: any = {
      state: createCtx.state,
      request: { body: { ...createCtx.request.body, model: 'gpt-new', name: 'Disabled create' } },
    }
    await controller.create(disabledCreateCtx)
    expect(disabledCreateCtx).toMatchObject({
      status: 409,
      body: { code: 'GROUP_AGENT_PRESET_REFERENCE_UNAVAILABLE' },
    })

    const disabledUpdateCtx: any = {
      state: createCtx.state,
      params: { presetId },
      request: { body: { ...createCtx.request.body, model: 'gpt-new' } },
    }
    await controller.update(disabledUpdateCtx)
    expect(disabledUpdateCtx).toMatchObject({
      status: 409,
      body: { code: 'GROUP_AGENT_PRESET_REFERENCE_UNAVAILABLE' },
    })

    modelGroups.value = [{
      provider: 'openai',
      models: ['gpt-test', 'gpt-new'],
      model_meta: { 'gpt-test': { disabled: true } },
    }]

    await expect(controller.resolveGroupAgentPresetForApplication(createCtx.state.user, presetId))
      .rejects.toMatchObject({ status: 409, code: 'GROUP_AGENT_PRESET_REFERENCE_UNAVAILABLE' })
    expect(snapshot).toMatchObject({ name: 'Reviewer API', model: 'gpt-new' })

    const listCtx: any = { state: createCtx.state, query: {} }
    await controller.list(listCtx)
    expect(listCtx.body.presets).toEqual([
      expect.objectContaining({ id: presetId, available: false, validationError: expect.stringContaining('unavailable') }),
    ])
  })

  it('keeps the stashed launch mode on a saved Cursor preset and clears it when the preset leaves Cursor', async () => {
    const { updateAgentStatus } = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const controller = await import('../../packages/server/src/modules/studio/controllers/group-agent-presets')
    initAllStores()
    modelGroups.value = [{ provider: 'openai', models: ['gpt-test'] }]
    updateAgentStatus('cursor', {
      installed: true,
      source: 'user-cli',
      path: 'agent',
    })
    updateAgentStatus('codex', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/codex',
    })
    const user = { id: 77, role: 'admin', profiles: ['research'] }
    const createCtx: any = {
      state: { user },
      request: { body: {
        agent: 'cursor',
        agentMode: 'global',
        priorAgentMode: 'global',
        profile: 'research',
        name: 'Cursor Reviewer',
        description: '',
        avatar: '',
      } },
    }
    await controller.create(createCtx)
    expect(createCtx.status).toBe(201)
    expect(createCtx.body.preset).toMatchObject({
      agent: 'cursor',
      agentMode: 'global',
      priorAgentMode: 'global',
    })

    await expect(controller.resolveGroupAgentPresetForApplication(user, createCtx.body.preset.id))
      .resolves.toMatchObject({ priorAgentMode: 'global' })

    const updateCtx: any = {
      state: { user },
      params: { presetId: createCtx.body.preset.id },
      request: { body: {
        agent: 'codex',
        agentMode: 'scoped',
        profile: 'research',
        provider: 'openai',
        model: 'gpt-test',
        apiMode: 'codex_responses',
        name: 'Cursor Reviewer',
        description: '',
        avatar: '',
      } },
    }
    await controller.update(updateCtx)
    expect(updateCtx.body.preset).toMatchObject({
      agent: 'codex',
      priorAgentMode: '',
    })
  })
})
