import Router from '@koa/router'
import * as ctrl from '../controllers/memory'

export const memoryRoutes = new Router()

memoryRoutes.get('/api/hermes/memory', ctrl.get)
memoryRoutes.post('/api/hermes/memory', ctrl.save)
