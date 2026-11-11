import type { PluginModule } from '../../contracts/plugins'

export function importPlugin(specifier: string): Promise<PluginModule>
