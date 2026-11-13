import type { Json } from './core'

export type BrowserTransport = (method: string, params: Record<string, Json>) => Promise<Json>
export interface BrowserTab { id: string; title: string; url: string; loading: boolean }
export interface BrowserTabs { activeTabId: string | null; maxTabs: number; tabs: BrowserTab[] }
export interface CdpEvent { sequence: number; method: string; params: Record<string, Json>; sessionId?: string; truncated?: boolean }
export interface CdpEvents { cursor: number; oldestCursor: number; dropped: boolean; events: CdpEvent[] }
/** Uses the selected Desktop's existing browser and login state. Requires browser.cdp. */
export interface PluginBrowser {
  tabs: { list(): Promise<BrowserTabs>; create(url?: string): Promise<BrowserTab>; close(tabId: string): Promise<BrowserTabs> }
  cdp: {
    attach(tabId: string): Promise<{ cursor: number; sessions: Array<{ sessionId: string; targetId: string }> }>
    send<T extends Json = Json>(tabId: string, method: string, params?: Record<string, Json>, sessionId?: string): Promise<T>
    events(tabId: string, cursor?: number, limit?: number): Promise<CdpEvents>
    release(tabId: string): Promise<{ ok: boolean }>
  }
}
