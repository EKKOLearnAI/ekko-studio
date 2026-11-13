/**
 * Broker projections and hand-rolled parameter validation (spec-05).
 *
 * The field names, error strings and validation style are transcribed verbatim
 * from `packages/desktop/src/main/browser/browser-broker.ts` — the MCP layer
 * (`bin/hermes-studio-mcp.mjs`) reads these shapes, so "improving" a name here
 * breaks a shipped consumer.
 */

import { publicBrowserUrl, redactBrowserText } from './url-policy'

export const BROKER_MAX_TABS = 8

export type BrokerAgentControl = 'idle' | 'active' | 'waiting-for-user'

/** Full internal tab state (never returned as-is). */
export interface BrokerTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: BrokerAgentControl
}

export interface BrokerStateInput {
  activeTabId: string | null
  maxTabs?: number
  tabs: BrokerTabState[]
}

export interface PublicBrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: BrokerAgentControl
}

export interface PublicBrowserState {
  activeTabId: string | null
  maxTabs: number
  tabs: PublicBrowserTab[]
}

/** Methods that do not mutate a tab and therefore need no lease. */
export const BROKER_NON_MUTATING_METHODS = ['state', 'tabs.list', 'console.read']

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function requiredString(value: unknown, name: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 4096) throw new Error(`${name} is required`)
  return result
}

export function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/**
 * Deliberately drops `faviconUrl`, `profileId`, `agentLabel`, `agentAction`,
 * session paths and anything CDP/DevTools related.
 */
export function publicTab(tab: BrokerTabState): PublicBrowserTab {
  return {
    id: tab.id,
    title: redactBrowserText(tab.title, 500),
    url: publicBrowserUrl(tab.url),
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    crashed: tab.crashed,
    agentControl: tab.agentControl,
  }
}

export function publicState(state: BrokerStateInput): PublicBrowserState {
  return {
    activeTabId: state.activeTabId,
    maxTabs: state.maxTabs ?? BROKER_MAX_TABS,
    tabs: state.tabs.map(tab => publicTab(tab)),
  }
}
