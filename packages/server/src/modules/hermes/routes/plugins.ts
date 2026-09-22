import Router from '@koa/router'
import * as ctrl from '../controllers/plugins'
import { requireSuperAdmin } from '../../studio/public/auth'

export const pluginRoutes = new Router()

pluginRoutes.get('/api/hermes/plugins', ctrl.list)
// Importing a plugin puts executable code in the profile, so it stays with the
// same role that manages the instance itself.
pluginRoutes.post('/api/hermes/plugins/import', requireSuperAdmin, ctrl.importPlugin)
pluginRoutes.post('/api/hermes/plugins/:key/enable', ctrl.enable)
pluginRoutes.post('/api/hermes/plugins/:key/disable', ctrl.disable)
