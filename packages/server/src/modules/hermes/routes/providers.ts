import Router from '@koa/router'
import * as ctrl from '../controllers/providers'
import { requireAdmin, requireUserProfile } from '../../studio/public/auth'
import * as apiRelayCtrl from '../controllers/api-relay'

export const providerRoutes = new Router()

/** Read APIKEY.FAN usage, deduplicated across the current user's accessible profiles. */
providerRoutes.get('/api/hermes/api-relay/usage', apiRelayCtrl.getRelayUsage)

providerRoutes.post('/api/hermes/config/providers', ctrl.create)
// Backward-compatible legacy update route. New clients should use the editor
// resource below for field capabilities and revision-checked writes.
providerRoutes.put('/api/hermes/config/providers/:poolKey', ctrl.update)
providerRoutes.delete('/api/hermes/config/providers/:poolKey', ctrl.remove)
providerRoutes.get('/api/hermes/config/providers/:poolKey/editor', requireUserProfile, requireAdmin, ctrl.getEditor)
providerRoutes.patch('/api/hermes/config/providers/:poolKey/editor', requireUserProfile, requireAdmin, ctrl.patchEditor)
providerRoutes.post('/api/hermes/config/providers/:poolKey/editor/test', requireUserProfile, requireAdmin, ctrl.testEditor)
providerRoutes.patch('/api/hermes/config/providers/:poolKey/editor/contexts', requireUserProfile, requireAdmin, ctrl.patchEditorContexts)
providerRoutes.post('/api/hermes/config/providers/:poolKey/models/refresh', requireUserProfile, requireAdmin, ctrl.refreshModels)
providerRoutes.post('/api/hermes/config/providers/:poolKey/models/restore', requireUserProfile, requireAdmin, ctrl.restoreModels)
