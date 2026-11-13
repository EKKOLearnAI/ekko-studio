import Router from '@koa/router'
import * as ctrl from '../controllers/pets'

export const petRoutes = new Router()

petRoutes.get('/api/studio/pets/active', ctrl.active)
petRoutes.patch('/api/studio/pets/active', ctrl.updateActive)
petRoutes.post('/api/studio/pets/adopt', ctrl.adopt)
