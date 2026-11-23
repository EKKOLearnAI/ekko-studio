import { normalizePluginRepository } from '@/api/studio/plugin-releases'
import type { InstalledPlugin } from '@/api/studio/plugins'
import { pluginRepository } from '@/plugins/updates'

export interface IntegrationBrand {
  title: string
  product: string
  image: string
  website: string
  attribution: string
}

const junieRepository = 'https://github.com/ekkolearnai/ekko-studio-plugin-junie'

// JetBrains Brand Assets, Product Icons → Junie → Embed. Keep the PNG online
// at its official source and link the mark to JetBrains, with visible credit.
const junie: Readonly<IntegrationBrand> = {
  title: 'Ekko Studio · Junie',
  product: 'JetBrains Junie',
  image: 'https://resources.jetbrains.com/storage/products/company/brand/logos/Junie_icon.png',
  website: 'https://www.jetbrains.com/',
  attribution: 'Copyright © 2026 JetBrains s.r.o. Junie and the Junie logo are trademarks of JetBrains s.r.o.',
}

export function pluginIntegrationBrand(id: string | null, repository: unknown) {
  if (id === 'junie' && normalizePluginRepository(repository) === junieRepository) return junie
}

export function installedIntegrationBrand(plugin: InstalledPlugin) {
  return pluginIntegrationBrand(plugin.manifest.id, pluginRepository(plugin))
}

export function agentIntegrationBrand(agentId: string, plugins: InstalledPlugin[]) {
  if (agentId !== 'plugin:junie/junie') return
  const plugin = plugins.find(plugin => plugin.manifest.id === 'junie')
  if (plugin) return installedIntegrationBrand(plugin)
}
