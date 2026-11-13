/** Studio plugin API v1. These contracts are shared by the host and browser. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Dispose = () => void | Promise<void>
export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  title?: string
  description?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  enum?: Json[]
  default?: Json
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  secret?: boolean
}
export const PLUGIN_PERMISSIONS = ['api.read', 'api.write', 'tools', 'commands', 'events', 'hooks', 'automation', 'ui', 'storage.client', 'agents', 'browser.cdp'] as const
export type PluginPermission = typeof PLUGIN_PERMISSIONS[number]
/** Host-rendered line icons; settings navigation never accepts images or arbitrary SVG. */
export const PLUGIN_ICON_PATHS = {
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M8 15v6',
  skills: 'm12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5',
  mcp: 'M5 5h14v10H5zM8 19h8M12 15v4M8 10h.01M12 10h4',
  code: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  terminal: 'm5 7 5 5-5 5M13 17h6',
  bot: 'M12 8V4H8M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3ZM2 14h2M20 14h2M9 13v2M15 13v2',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  book: 'M12 5v16M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3V3Z',
  chart: 'M3 3v18h18M7 15l4-5 4 3 5-7',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  history: 'M3 12a9 9 0 1 0 3-7M3 3v5h5M12 7v5l3 2',
  chat: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z',
} as const
export type PluginIconName = keyof typeof PLUGIN_ICON_PATHS
export interface PluginNavigationEntry {
  viewId: string
  /** Defaults to the target view's title. */
  title?: string
  /** Required: named icon; main navigation also accepts bundled raster images. */
  icon: string
  order?: number
}
export interface PluginSettingsNavigationEntry extends Omit<PluginNavigationEntry, 'icon'> { icon: PluginIconName }
export interface PluginView {
  id: string
  title: string
  /** Page layout only. Global sidebar entries are declared separately in navigation. */
  slot: 'page' | 'settings' | 'workspace' | 'agent-settings'
  icon?: string
  order?: number
}
export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  description?: string
  author?: { name: string; url?: string }
  repository?: string
  homepage?: string
  documentation?: string
  issues?: string
  changelog?: string
  license?: string
  keywords?: string[]
  /** Relative bundled PNG/JPEG/WebP/GIF, or an inline base64 image. */
  icon?: string
  server?: string
  /** A bundled ES module exporting mount(element, ctx), optionally returning a disposer. */
  client?: string
  permissions: PluginPermission[]
  /** Omit to share ekko-studio-plugins; otherwise expose tools on this dedicated MCP server. */
  mcp?: { name: string }
  configSchema?: Schema
  dependencies?: Record<string, string>
  views?: PluginView[]
  /** Explicit, independent global entries. Omitted lists expose no sidebar entry. */
  navigation?: { main?: PluginNavigationEntry[]; settings?: PluginSettingsNavigationEntry[] }
  /** Optional dynamic sidebar view, mounted from the same client module. */
  workspace?: { sidebar: string }
}
export interface PluginIdentity {
  readonly userId: number
  readonly profile: string
  readonly sessionId?: string
  readonly runId?: string
  readonly runtime?: string
  readonly surface?: string
  readonly workspace?: string
}

export interface PluginLifecycle {
  add(dispose: Dispose): Dispose
  acquire(acquire: () => Dispose | Promise<Dispose>): Promise<Dispose>
}
