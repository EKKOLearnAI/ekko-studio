import { readPresetStyleSource as readFileSync } from './preset-style-source'
import { describe, expect, it } from 'vitest'

const readClientFile = (path: string) => readFileSync(`packages/client/src/${path}`, 'utf8')

describe('Ekko configuration navigation', () => {
  it('uses independent routes and an Ekko-only sidebar', () => {
    const app = readClientFile('App.vue')
    const router = readClientFile('router/index.ts')
    const sidebar = readClientFile('components/layout/EkkoConfigSidebar.vue')
    const hermesSidebar = readClientFile('components/layout/HermesConfigSidebar.vue')
    const agentManager = readClientFile('views/hermes/AgentManagerView.vue')

    expect(app).toContain('@/components/layout/EkkoConfigSidebar.vue')
    expect(app).toContain('route.meta?.ekkoConfig === true')
    expect(app).toContain('v-if="!isLoginPage && usesEkkoConfigSidebar"')
    expect(app).toContain("'has-ekko-config-sidebar': usesEkkoConfigSidebar")
    expect(app).toContain('.no-sidebar:not(.has-hermes-config-sidebar):not(.has-ekko-config-sidebar):not(.has-coding-agent-config-sidebar) &')

    for (const [path, name] of [
      ['/ekko/memory', 'ekko.memory'],
      ['/ekko/skills', 'ekko.skills'],
      ['/ekko/mcp', 'ekko.mcp'],
      ['/ekko/settings', 'ekko.settings'],
    ]) {
      expect(router).toContain(`path: '${path}'`)
      expect(router).toContain(`name: '${name}'`)
      expect(sidebar).toContain(`name: '${name}'`)
    }
    expect(router.match(/ekkoConfig: true/g)).toHaveLength(4)
    expect(sidebar).toContain("name: 'hermes.agentManager'")
    expect(sidebar).not.toContain("name: 'hermes.memory'")
    expect(sidebar).not.toContain("name: 'hermes.skills'")
    expect(sidebar).not.toContain("name: 'hermes.mcp'")
    expect(sidebar).toContain('@include agent-config-sidebar.layout("ekko")')
    expect(hermesSidebar).toContain('@include agent-config-sidebar.layout("hermes")')
    expect(agentManager).toContain("router.push({ name: 'ekko.settings' })")
  })

  it('uses the Hermes settings layout for every user-facing Ekko config section', () => {
    const settings = readClientFile('views/ekko/SettingsView.vue')

    expect(settings).toContain("@/components/hermes/settings/SettingRow.vue")
    expect(settings).toContain('class="page-header"')
    expect(settings).toContain('<NTabs')
    for (const tab of ['runtime', 'model', 'tools', 'modules', 'advanced']) {
      expect(settings).toContain(`name="${tab}"`)
    }
    for (const section of ['runtime', 'model', 'tools', 'mcp', 'delegation', 'memory', 'skills', 'logging', 'prompt']) {
      expect(settings).toContain(`form.${section}`)
    }
    expect(settings).toContain('fetchEkkoSettings')
    expect(settings).toContain('saveEkkoSettings')
    expect(settings).not.toContain("t('ekkoConfig.defaultProvider')")
    expect(settings).not.toContain("t('ekkoConfig.defaultModel')")
    expect(settings).not.toContain("t('ekkoConfig.noDefaultProvider')")
    expect(settings).not.toContain('class="header-actions"')
    expect(settings).not.toContain('max-width: 880px')
    expect(settings).not.toContain('width: min(360px, 46vw)')
    expect(settings).toContain('class="input-sm"')
    expect(settings).toContain('class="input-md"')
    expect(settings).toContain('@update:value="saveImmediateChange"')
    expect(settings).toContain('saveDebouncedChange')
    expect(settings).not.toContain('watch(form')
    expect(settings.match(/:hint="t\('ekkoConfig\.[A-Za-z]+Hint'\)"/g)).toHaveLength(36)
    expect(settings).toContain('.input-sm { width: 120px; }')
    expect(settings).toContain('.input-md { width: 240px; }')
    expect(settings).toContain('.input-lg { width: 360px; }')
    expect(settings).toContain('padding: 20px')

    const mainSidebar = readClientFile('components/layout/AppSidebar.vue')
    const mainGearPath = 'M19.4 15a1.65 1.65 0 0 0 .33 1.82'
    expect(mainSidebar).toContain(mainGearPath)
    expect(readClientFile('components/layout/EkkoConfigSidebar.vue')).toContain(mainGearPath)
  })

  it('keeps Ekko Skills and MCP on the Hermes configuration page patterns', () => {
    const skills = readClientFile('views/ekko/SkillsView.vue')
    const hermesSkills = readClientFile('views/hermes/SkillsView.vue')
    const sourceLegend = readClientFile('components/hermes/skills/SkillSourceLegend.vue')
    const mcp = readClientFile('views/ekko/McpView.vue')

    for (const className of ['skills-view', 'skills-layout', 'skills-sidebar', 'skills-main']) {
      expect(skills).toContain(`class="${className}`)
    }
    expect(skills).toContain('mobile-backdrop')
    expect(skills).toContain("@/components/hermes/skills/SkillList.vue")
    expect(skills).toContain("@/components/hermes/skills/SkillDetail.vue")
    expect(skills).toContain("@/components/hermes/skills/SkillImportModal.vue")
    expect(skills).toContain("@/components/hermes/skills/SkillExternalDirsModal.vue")
    expect(skills).toContain('<SkillSourceLegend v-model="sourceFilter" />')
    expect(hermesSkills).toContain('<SkillSourceLegend v-model="sourceFilter" :show-hub="isHermesTarget" />')
    for (const source of ['builtin', 'hub', 'local', 'external', 'modified']) {
      expect(sourceLegend).toContain(`toggle('${source}')`)
    }
    expect(sourceLegend).toContain("{{ t('skills.modified') }}")
    expect(skills).toContain("@use '@/styles/skills-manager'")
    expect(skills).toContain('source: skill.source')
    expect(skills).toContain(':import-handler="importEkkoSkill"')
    expect(skills).toContain(':save-handler="saveEkkoExternalDirectories"')
    expect(skills).not.toContain('showCreateModal')
    expect(skills).not.toContain('newSkillName')
    expect(skills).not.toContain('ekkoConfig.newSkill')

    for (const className of ['mcp-view', 'summary-grid', 'toolbar-row', 'servers-grid']) {
      expect(mcp).toContain(`class="${className}`)
    }
    expect(mcp).toContain("@/components/hermes/mcp/McpServerCard.vue")
    expect(mcp).toContain("@use '@/styles/mcp-manager'")
    expect(mcp).not.toContain(':readonly="server.managed"')
    expect(mcp).not.toContain(':allow-readonly-toggle="server.managed"')
    expect(mcp).toContain('void probeEnabledServers(loadedServers)')
    expect(mcp).toContain('await Promise.allSettled(')
    expect(mcp).toContain('<NRadioButton value="json">JSON</NRadioButton>')
    expect(mcp).toContain('<NRadioButton value="yaml">YAML</NRadioButton>')
  })
})
