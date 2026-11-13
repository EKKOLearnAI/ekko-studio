import Router from '@koa/router'
import * as ctrl from '../controllers/plugins'

export const pluginRoutes = new Router()

pluginRoutes.get('/api/hermes/plugins', ctrl.list)
pluginRoutes.post('/api/hermes/plugins/:key/enable', ctrl.enable)
pluginRoutes.post('/api/hermes/plugins/:key/disable', ctrl.disable)
