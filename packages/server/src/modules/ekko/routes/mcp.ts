import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/mcp'

export const ekkoMcpRoutes = new Router()

ekkoMcpRoutes.get('/api/ekko/mcp/servers', requireSuperAdmin, ctrl.list)
ekkoMcpRoutes.post('/api/ekko/mcp/servers', requireSuperAdmin, ctrl.create)
ekkoMcpRoutes.patch('/api/ekko/mcp/servers/:name', requireSuperAdmin, ctrl.update)
ekkoMcpRoutes.delete('/api/ekko/mcp/servers/:name', requireSuperAdmin, ctrl.remove)
ekkoMcpRoutes.post('/api/ekko/mcp/servers/:name/test', requireSuperAdmin, ctrl.test)
