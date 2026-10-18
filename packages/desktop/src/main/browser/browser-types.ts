export const MAX_BROWSER_TABS = 12

export type BrowserAgentControl = 'idle' | 'active' | 'waiting-for-user'
export type BrowserProxyMode = 'direct' | 'system' | 'fixed_servers'

export interface BrowserProfileCreateInput {
  name: string
  rootDirectory: string
  proxyMode?: BrowserProxyMode
  proxyRules?: string
}

export interface BrowserProfileUpdateInput {
  rootDirectory?: string
  proxyMode?: BrowserProxyMode
  proxyRules?: string
  askBeforeDownload?: boolean
  downloadConflictPolicy?: 'ask' | 'uniquify'
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopBrowserTab {
  id: string
  profileId: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: BrowserAgentControl
  agentLabel?: string
  agentAction?: string
}

export interface DesktopBrowserProfile {
  id: string
  name: string
  rootPath: string
  sessionPath: string
  downloadPath: string
  proxyMode: BrowserProxyMode
  proxyRules: string
  askBeforeDownload: boolean
  downloadConflictPolicy: 'ask' | 'uniquify'
  createdAt: string
  lastUsedAt: string
  tabs: string[]
}

export interface DesktopBrowserDownload {
  id: string
  profileId: string
  fileName: string
  sourceUrl: string
  savePath?: string
  receivedBytes: number
  totalBytes: number
  state: 'blocked' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: string
}

export interface BrowserSitePermission {
  id: string
  profileId: string
  origin: string
  permission: string
  allowed: boolean
  lastRequestedAt: string
}

export interface DesktopBrowserState {
  available: boolean
  activeProfileId: string
  activeTabId?: string
  tabs: DesktopBrowserTab[]
  profiles: DesktopBrowserProfile[]
  downloads: DesktopBrowserDownload[]
  permissions: BrowserSitePermission[]
  visible: boolean
  maxTabs: number
}

export interface BrowserSnapshotNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  disabled?: boolean
  focused?: boolean
  checked?: boolean | 'mixed'
  selected?: boolean
  expanded?: boolean
  pressed?: boolean | 'mixed'
}

/** Observations are evidence, not a semantic assertion that the user's goal was met. */
export interface BrowserObservation {
  tabId?: string
  status: 'observed' | 'unavailable'
  changed?: boolean
  changeCount?: number
  changes?: Array<{ before?: BrowserSnapshotNode; after?: BrowserSnapshotNode }>
  targets?: Array<{ before?: BrowserSnapshotNode; after?: BrowserSnapshotNode; valueMatches?: boolean }>
  navigation?: 'same_document' | 'new_document'
  openedTabs?: Array<Pick<DesktopBrowserTab, 'id' | 'title' | 'url'>>
  hint: string
}

export interface BrowserInteractionResult extends DesktopBrowserTab {
  snapshot?: BrowserSnapshot
  snapshotError?: string
  observation?: BrowserObservation
}

export interface BrowserSnapshotOptions {
  snapshotId?: string
  selector?: string
  query?: string
  interactiveOnly?: boolean
  offset?: number
  limit?: number
}

export interface BrowserSnapshot {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  text: string
  totalNodes?: number
  matchedNodes?: number
  offset?: number
  limit?: number
  hasMore?: boolean
  nextOffset?: number
  truncated?: boolean
  scope?: { selector?: string; query?: string; interactiveOnly?: boolean }
  hint?: string
}

export type BrowserTextMode = 'innerText' | 'textContent'

export const DEFAULT_BROWSER_TEXT_READ_LIMIT = 4_000
export const MAX_BROWSER_TEXT_READ_LIMIT = 20_000

export interface BrowserReadTextOptions {
  snapshotId: string
  ref: string
  mode: BrowserTextMode
  offset: number
  limit: number
}

export interface BrowserReadTextResult {
  tabId: string
  snapshotId: string
  ref: string
  mode: BrowserTextMode
  offset: number
  limit: number
  text: string
  totalLength: number
  returnedLength: number
  hasMore: boolean
  nextOffset?: number
}

export interface BrowserScreenshot {
  tabId: string
  url: string
  title: string
  mediaType: 'image/png' | 'image/jpeg'
  data: string
  width: number
  height: number
}

export interface BrowserConsoleEntry {
  level: number
  message: string
  sourceId: string
  line: number
  timestamp: string
}

export interface BrowserSelection {
  tabId: string
  marker: number
  mode: 'element' | 'region'
  url: string
  title: string
  viewport: {
    width: number
    height: number
    scaleFactor: number
  }
  region: BrowserBounds
  element?: {
    role?: string
    name?: string
    tag?: string
    id?: string
    classNames?: string[]
  }
  screenshot: BrowserScreenshot
}

export interface BrowserProfileSwitchImpact {
  activeAgentRuns: number
  activeDownloads: number
  pendingAnnotations: number
  openTabs: number
  requiresConfirmation: boolean
}

export interface BrowserBrokerDescriptor {
  schema: 1
  desktopPid: number
  endpoint: string
  token: string
  instanceId: string
  createdAt: string
}

export type BrowserInteractAction =
  | { action: 'click'; ref: string; snapshot_id: string }
  | { action: 'type'; ref: string; snapshot_id: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels?: number }

export type BrowserBatchAction =
  | { action: 'click'; ref: string }
  | { action: 'type'; ref: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels?: number }

export interface BrowserBatchResult {
  tabId: string
  completed: number
  total: number
  results: Array<{ index: number; action: BrowserBatchAction['action']; status: 'completed' | 'failed' | 'skipped'; error?: string }>
  snapshot?: BrowserSnapshot
  snapshotError?: string
  observation?: BrowserObservation
}
