import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('keeps update settings out of action buttons and hides raw process errors',()=>{
 const s=readFileSync('packages/client/src/views/hermes/AgentManagerView.vue','utf8')
 expect(s).toContain('class="agent-update-policy-row"')
 expect(s).toMatch(/<NSwitch[^>]*\bsize="small"/)
 expect(s).toContain('availableUpdateVersion(agent.id)')
 expect(s).toContain('!updatePolicies[agent.id]?.autoUpdateSupported')
 expect(s).not.toContain('>New ·')
 expect(s).not.toContain('{{ updatePolicies[agent.id]?.error }}')
 expect(s).toContain("t('codingAgents.checkUpdateFailed')")
})

it('update button formats target version with the same v prefix as installed version',()=>{
 const s=readFileSync('packages/client/src/views/hermes/AgentManagerView.vue','utf8')
 expect(s).toContain('version: formatVersion(availableUpdateVersion(agent.id))')
 expect(s).toContain('if (result.updateState) updatePolicies.value[id] = result.updateState')
})


it('does not schedule npm update checks for the native Antigravity CLI', () => {
 const source = readFileSync('packages/server/src/modules/coding-agents/services/update-manager.ts', 'utf8')
 expect(source).toContain("safelyManaged:id=>id!=='cursor' && id!=='antigravity'")
})


it('manual version checks update the policy used to render the update button', () => {
 const source = readFileSync('packages/client/src/views/hermes/AgentManagerView.vue', 'utf8')
 expect(source).toContain('latestVersion: result.latestVersion')
 expect(source).toContain("status: result.tool.installed && result.updateAvailable ? 'available' : 'current'")
})
