import Router from '@koa/router'
import * as ctrl from '../controllers/speech-practice'

/**
 * 口语对练（speech-practice）路由。
 *
 * - POST /api/studio/speech-practice/report：会话结束后客户端把生成的
 *   Markdown 分析报告 POST 过来，服务端写入 Web UI state 目录并返回文件名 /
 *   绝对路径；下载走既有的 `/api/studio/download`。
 * - POST /api/studio/speech-practice/omni-analysis：把练习期间录制的用户
 *   语音 + 摄像头帧 + 转写交给 Qwen3.5-Omni（HTTP 全模态）生成一段深度
 *   分析 Markdown（不落盘，由客户端拼进报告后再走 /report）。
 *
 * 两条都必须在 catch-all 之前注册（见 routes/index.ts）。
 */
export const speechPracticeRoutes = new Router()

speechPracticeRoutes.post('/api/studio/speech-practice/report', ctrl.savePracticeReport)
speechPracticeRoutes.post('/api/studio/speech-practice/omni-analysis', ctrl.generateOmniAnalysis)
