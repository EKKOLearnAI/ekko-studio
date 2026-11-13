import Router from '@koa/router'
import { gradingRequest } from '../controllers/grading'
import * as ctrl from '../controllers/scanner'

/**
 * 扫描 OCR 插件路由。
 *
 * 端点列表：
 *   POST /api/studio/scanner/ocr   — 提交图片（多页）做 DashScope Qwen-VL-OCR 识别
 *   POST /api/studio/scanner/pdf   — 把多张扫描图打包成 PDF（图片直嵌）
 *   POST /api/studio/scanner/save  — 把扫描图 + OCR 文本写到 Hermes profile workspace
 *
 * 必须注册在任何代理 catch-all 之前（见 routes/index.ts）。
 */
export const scannerRoutes = new Router()

scannerRoutes.post('/api/studio/scanner/ocr', ctrl.runOcr)
scannerRoutes.post('/api/studio/scanner/pdf', ctrl.buildPdf)
scannerRoutes.post('/api/studio/scanner/save', ctrl.saveScan)

scannerRoutes.get('/api/studio/scanner/grading/:action', gradingRequest)
scannerRoutes.post('/api/studio/scanner/grading/:action', gradingRequest)
