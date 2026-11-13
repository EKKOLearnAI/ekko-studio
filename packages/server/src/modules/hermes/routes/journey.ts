import Router from '@koa/router'
import * as ctrl from '../controllers/journey'

export const journeyRoutes = new Router()

journeyRoutes.get('/api/hermes/journey', ctrl.graph)
