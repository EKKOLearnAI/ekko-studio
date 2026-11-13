import Router from '@koa/router'
import * as ctrl from '../controllers/health'

export const healthRoutes = new Router()

healthRoutes.get('/livez', ctrl.livenessCheck)
healthRoutes.get('/health', ctrl.healthCheck)
