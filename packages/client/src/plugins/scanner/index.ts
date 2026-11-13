import type { HermesClientPlugin } from '../types'
import { defineAsyncComponent } from 'vue'
const ScannerView = defineAsyncComponent(() => import('./ScannerView.vue'))
import { loadPluginMessages, SUPPORTED_LOCALES } from './i18n-loader'

/**
 * Scanner 插件入口。
 *
 * 通过 `install(ctx)` 把 ScannerView 路由、侧边栏入口、各 locale 文案注入
 * 到 Web UI 核心。**核心代码（router / sidebar）不直接 import 本文件**，
 * 只通过 `packages/client/src/plugins/index.ts` 间接加载；要彻底卸载
 * 插件，只需在 registry 里删除这一行。
 */
const scannerPlugin: HermesClientPlugin = {
  id: 'scanner',
  name: 'Scanner',
  version: '0.1.0',
  description: 'UVC USB camera scanning with Qwen-VL-OCR recognition.',
  author: 'Hermes',

  async install(ctx) {
    // 1) 合并 i18n 文案：把所有有翻译的 locale 注入 i18n。
    const results = await Promise.all(
      SUPPORTED_LOCALES.map(async (locale) => ({
        locale,
        messages: await loadPluginMessages(locale),
      })),
    )
    for (const { locale, messages } of results) {
      if (messages && Object.keys(messages).length > 0) {
        ctx.addI18nMessages(locale, messages)
      }
    }

    // 2) 注册路由。path/name 都用 plugin-scanner:* 前缀避免与 core 路由冲突。
    ctx.addRoute({
      path: '/hermes/scanner',
      name: 'plugin-scanner.scanner',
      component: ScannerView,
    })

    // 3) 注册侧边栏入口。
    ctx.addSidebarItem({
      routeName: 'plugin-scanner.scanner',
      group: 'Tools',
      labelKey: 'pluginsScanner.sidebarLabel',
      iconPath: 'M5 7h3l2-3h4l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    })
  },
}

export default scannerPlugin
