import Router from '@koa/router'
import * as ctrl from '../controllers/realtime-model'

/**
 * Realtime (Qwen / DashScope) model settings routes.
 *
 * Profile-scoped server persistence for the "设置 → 模型 → Realtime 模型"
 * configuration (DashScope API key + realtime model + default voice), the same
 * way STT/TTS settings are stored. Must be registered before any proxy
 * catch-all (see routes/index.ts).
 */
export const realtimeModelRoutes = new Router()

realtimeModelRoutes.get('/api/studio/realtime-model/settings', ctrl.getSettings)
realtimeModelRoutes.put('/api/studio/realtime-model/settings', ctrl.saveSettings)
realtimeModelRoutes.delete('/api/studio/realtime-model/settings', ctrl.removeSettings)
