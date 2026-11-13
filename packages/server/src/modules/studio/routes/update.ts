import Router from '@koa/router'
import * as ctrl from '../controllers/update'
import { requireSuperAdmin } from '../middleware/super-admin'

export const updateRoutes = new Router()

updateRoutes.post('/api/studio/update', ctrl.handleUpdate)
updateRoutes.post('/api/studio/update/reconcile', ctrl.reconcileUpdate)
updateRoutes.get('/api/studio/update/environment', ctrl.getUpdateEnvironment)
updateRoutes.get('/api/studio/update/status', ctrl.updateStatus)
updateRoutes.get('/api/studio/update/capabilities', ctrl.updateCapabilities)
updateRoutes.get('/api/studio/update/identity', ctrl.getUpdateIdentity)
updateRoutes.post('/api/studio/update/identity/repair', ctrl.repairUpdateIdentity)
updateRoutes.post('/api/studio/update/status/clear-stale', ctrl.clearStaleUpdateStatus)
updateRoutes.get('/api/studio/update/preview', requireSuperAdmin, ctrl.previewStatus)
updateRoutes.get('/api/studio/update/preview/tags', requireSuperAdmin, ctrl.previewTags)
updateRoutes.post('/api/studio/update/preview/prepare', requireSuperAdmin, ctrl.preparePreview)
updateRoutes.post('/api/studio/update/preview/install', requireSuperAdmin, ctrl.installPreview)
updateRoutes.post('/api/studio/update/preview/start', requireSuperAdmin, ctrl.startPreview)
updateRoutes.post('/api/studio/update/preview/stop', requireSuperAdmin, ctrl.stopPreview)
