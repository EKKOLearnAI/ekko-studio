import Router from '@koa/router'
import * as ctrl from '../controllers/jobs'

export const jobRoutes = new Router()

jobRoutes.get('/api/hermes/jobs', ctrl.list)
jobRoutes.get('/api/hermes/jobs/delivery-targets', ctrl.deliveryTargets)
jobRoutes.get('/api/hermes/jobs/:id', ctrl.get)
jobRoutes.post('/api/hermes/jobs', ctrl.create)
jobRoutes.patch('/api/hermes/jobs/:id', ctrl.update)
jobRoutes.delete('/api/hermes/jobs/:id', ctrl.remove)
jobRoutes.post('/api/hermes/jobs/:id/pause', ctrl.pause)
jobRoutes.post('/api/hermes/jobs/:id/resume', ctrl.resume)
jobRoutes.post('/api/hermes/jobs/:id/run', ctrl.run)
