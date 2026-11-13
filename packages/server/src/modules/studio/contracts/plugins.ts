export type * from '../../../../../plugin-sdk/src'
export { PLUGIN_ICON_PATHS, PLUGIN_PERMISSIONS } from '../../../../../plugin-sdk/src'
export interface PluginRecord {
  manifest: import('../../../../../plugin-sdk/src').PluginManifest
  directory: string
  source: string
  developmentDirectory?: string
  installedAt: number
  enabled: boolean
  config: Record<string, import('../../../../../plugin-sdk/src').Json>
  /** Identity used only for startup and the single global recurring scheduler. */
  runtimeIdentity?: import('../../../../../plugin-sdk/src').PluginIdentity
  previous?: Omit<PluginRecord, 'previous'>
}
export interface PluginSnapshot {
  revision: number
  plugins: Array<Omit<PluginRecord, 'directory' | 'previous' | 'runtimeIdentity'> & {
    status: 'disabled' | 'active' | 'failed'
    error?: string
    previousVersion?: string
    tools: Array<{ name: string; description: string; inputSchema: import('../../../../../plugin-sdk/src').Schema; readOnly?: boolean }>
    commands: Array<{ name: string; description: string }>
    actions: Array<{ name: string; description: string; inputSchema: import('../../../../../plugin-sdk/src').Schema }>
  }>
}
