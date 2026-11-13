import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** DSH runtime policy and composition must not become shared agent behavior. */
export function dshModuleViolations(filename, source) {
  const file = filename.replaceAll('\\', '/')
  if (file.startsWith('packages/client/src/')) {
    if (file.includes('/components/coding-agents/dsh/') || file === 'packages/client/src/api/coding-agents/dsh.ts') return []
    const importsDshApi = /from ['"][^'"]*api\/coding-agents\/dsh['"]/.test(source)
    const leaksDsh = source.includes('settings.plugin.item') || source.includes('agentPresets/list') || source.includes('STUDIO_DSH_UI_READY') || source.includes('/api/coding-agents/dsh/ui-session') || source.includes('/api/coding-agents/dsh/session-presets')
    return importsDshApi || leaksDsh ? [`${file}: DSH forms and API behavior belong in the DSH client module`] : []
  }
  if (source.includes('/modlens/config') || source.includes('saveModlensSettings') || source.includes('settingsFields(')) return [`${file}: plugin-specific forms and endpoints belong to native DSH plugins`]
  if (source.includes('managedPluginPatches') || source.includes('getDshPluginStore')) return [`${file}: obsolete ACP plugin overlays must not be loaded`]
  if (file.includes('/services/dsh/')) {
    return /from ['"](?:\.\.\/index|\.\.)['"]/.test(source)
      ? [`${file}: DSH services must receive platform helpers instead of importing the agent registry`] : []
  }
  const failures = []
  for (const token of ['DSH_PERMISSION_MODE', 'studio-web-acp', '@deepseek-ai/dsh-web-app', 'writeDshAcpAdapter', 'prepareDshWebProfile', 'new DshAcpTurn(', 'STUDIO_DSH_UI_READY', 'prepareDshManagementProfile', 'DSH_UI_SLOT_CLIENT', 'dshPresetSourceConfig', 'new DshAgentPresetService(']) {
    if (source.includes(token)) failures.push(`${file}: ${token} belongs in coding-agents/services/dsh`)
  }
  if (/function\s+(?:executeDshPluginCommand|getNativeDshPluginInventory)\s*\(/.test(source)) failures.push(`${file}: implement DSH plugin operations inside services/dsh; registry wiring may only delegate`)
  if (/function\s+(?:findDshSkillFile|listDshSkills|validateDshSkill)\s*\(/.test(source)) failures.push(`${file}: DSH skill formats belong in services/dsh`)
  return failures
}

export async function checkDshModuleBoundaries(root) {
  const failures = []
  async function visit(directory) {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`
      if (item.isDirectory()) await visit(file)
      else if (/\.(ts|vue)$/.test(item.name)) failures.push(...dshModuleViolations(file, await readFile(path.join(root, file), 'utf8')))
    }
  }
  await visit('packages/server/src')
  await visit('packages/client/src')
  return failures
}
