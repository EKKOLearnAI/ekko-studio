import Router from '@koa/router'
import * as ctrl from '../controllers/models'
import { requireUserProfile } from '../../studio/public/auth'

export const modelRoutes = new Router()

modelRoutes.get('/api/hermes/available-models', ctrl.getAvailable)
modelRoutes.get('/api/hermes/provider-models', requireUserProfile, ctrl.getProviderModelCatalog)
modelRoutes.post('/api/hermes/provider-models', ctrl.fetchProviderModelList)
modelRoutes.post('/api/hermes/provider-models/cache/refresh', ctrl.refreshProviderModelCatalogCache)
modelRoutes.get('/api/hermes/config/models', ctrl.getConfigModels)
modelRoutes.put('/api/hermes/config/model', ctrl.setConfigModel)
modelRoutes.put('/api/hermes/model-alias', ctrl.setModelAlias)
modelRoutes.put('/api/hermes/model-visibility', ctrl.setModelVisibility)
modelRoutes.put('/api/hermes/custom-model', ctrl.addCustomModel)
modelRoutes.delete('/api/hermes/custom-model', ctrl.removeCustomModel)

// Model context routes
modelRoutes.get('/api/hermes/model-context', ctrl.getModelContext)
modelRoutes.get('/api/hermes/model-context/:provider/:model', ctrl.getModelContext)
modelRoutes.put('/api/hermes/model-context/:provider/:model', ctrl.updateModelContext)
modelRoutes.put('/api/hermes/model-context', ctrl.updateModelContext)
