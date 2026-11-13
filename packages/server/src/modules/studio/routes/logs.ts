import Router from '@koa/router'
import * as ctrl from '../controllers/logs'

export const logRoutes = new Router()

logRoutes.get('/api/studio/logs', ctrl.list)
logRoutes.get('/api/studio/logs/:name', ctrl.read)
