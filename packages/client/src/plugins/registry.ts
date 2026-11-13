import type { App } from 'vue'
import { registerAdditionalLocaleMessages } from '@/i18n/messages'
import type { Router } from 'vue-router'

/**
 * vue-i18n 11 的 `I18n` 类型对 locale schema 进行了深度参数化；插件安装时
 * 传入的具体 i18n 实例 schema 与插件无关，因此这里用一个结构性最简的本地
 * 类型代替（运行时只用 `setLocaleMessage` / `getLocaleMessage`）。
 */
type PluginI18n = {
  global: {
    getLocaleMessage(locale: string): Record<string, unknown>
    setLocaleMessage(locale: string, messages: Record<string, unknown>): void
  }
}
import {
  isPluginEnabled,
  type HermesClientPlugin,
  type PluginContext,
  type PluginRegistration,
  type PluginSidebarItem,
  type SupportedLocale,
} from './types'

/**
 * 客户端插件注册中心。
 *
 * 用法：
 *   - 插件模块放在 `packages/client/src/plugins/<id>/index.ts`，导出一个
 *     HermesClientPlugin 对象。
 *   - `BUILTIN_PLUGINS` 列出所有「内置」插件；启用/禁用由 `isPluginEnabled()`
 *     在运行时根据 localStorage 决定。
 *   - 主应用在 `installClientPlugins()` 里调用 install(ctx) 并把侧边栏 /
 *     路由注册到 router。
 *
 * 把插件从 `BUILTIN_PLUGINS` 移除 = 编译期下线（vite 会 treeshake 未引用的
 * 模块）；把 localStorage 的开关关掉 = 运行时下线。
 */

const sidebarItemsByRoute = new Map<string, PluginSidebarItem>()
let installedPlugins = new Set<string>()

function createContext(app: App, router: Router, i18n: PluginI18n): PluginContext {
  return {
    app,
    router,
    i18n: i18n as unknown as PluginContext['i18n'],
    addSidebarItem(item) {
      sidebarItemsByRoute.set(item.routeName, item)
    },
    addRoute(route) {
      router.addRoute(route)
    },
    addI18nMessages(locale, messages) {
      registerAdditionalLocaleMessages(locale, messages)
      const existing = i18n.global.getLocaleMessage(locale) || {}
      if (Object.keys(existing).length > 0) {
        i18n.global.setLocaleMessage(locale, deepMerge(existing, messages))
      }
    },
  }
}

function deepMerge(base: any, override: any): any {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base
  const out: Record<string, unknown> = { ...(base || {}) }
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object') {
      out[key] = deepMerge(existing, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * 安装运行时启用的所有内置插件。
 * 已安装过的插件会被跳过（避免 HMR / 多次挂载导致重复注册）。
 */
export async function installClientPlugins(
  app: App,
  router: Router,
  i18n: PluginI18n,
  registrations: PluginRegistration[],
): Promise<{ installedIds: string[]; sidebarItems: PluginSidebarItem[] }> {
  const ctx = createContext(app, router, i18n)
  const installedIds: string[] = []
  for (const registration of registrations) {
    const plugin: HermesClientPlugin = registration.plugin
    if (!plugin || typeof plugin.install !== 'function') continue
    if (!isPluginEnabled(plugin.id, registration.enabledByDefault)) continue
    if (plugin.dependencies?.some(id => !installedPlugins.has(id))) continue
    if (installedPlugins.has(plugin.id)) continue
    try {
      await plugin.install(ctx)
      installedPlugins.add(plugin.id)
      installedIds.push(plugin.id)
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[plugins] failed to install "${plugin.id}":`, error)
    }
  }
  return { installedIds, sidebarItems: Array.from(sidebarItemsByRoute.values()) }
}

/**
 * 列出当前 sidebarItems；供 AppSidebar 渲染插件入口。
 */
export function listSidebarItems(): PluginSidebarItem[] {
  return Array.from(sidebarItemsByRoute.values())
}

/**
 * 重置内部缓存（仅测试 / HMR 时使用）。
 * @internal
 */
export function _resetForTesting(): void {
  sidebarItemsByRoute.clear()
  installedPlugins = new Set()
}

export type {
  HermesClientPlugin,
  PluginContext,
  PluginRegistration,
  PluginSidebarItem,
  SupportedLocale,
}