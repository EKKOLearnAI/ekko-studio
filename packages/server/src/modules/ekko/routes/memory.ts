import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/memory'

export const ekkoMemoryRoutes = new Router()

ekkoMemoryRoutes.get('/api/ekko/memory', requireSuperAdmin, ctrl.list)
ekkoMemoryRoutes.patch('/api/ekko/memory/:id', requireSuperAdmin, ctrl.update)
ekkoMemoryRoutes.delete('/api/ekko/memory/:id', requireSuperAdmin, ctrl.remove)
