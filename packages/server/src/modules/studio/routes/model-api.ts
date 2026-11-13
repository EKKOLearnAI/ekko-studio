import Router from '@koa/router'
import * as ctrl from '../controllers/model-api'

export const modelApiRoutes = new Router()
modelApiRoutes.get('/api/studio/models/cloud-link', ctrl.modelApiCloudLink)
modelApiRoutes.post('/api/studio/models/cloud-link', ctrl.modelApiCloudLink)
modelApiRoutes.delete('/api/studio/models/cloud-link', ctrl.modelApiCloudLink)
modelApiRoutes.get('/api/studio/models/api-keys', ctrl.modelApiKeys)
modelApiRoutes.post('/api/studio/models/api-keys', ctrl.modelApiCreateKey)
modelApiRoutes.patch('/api/studio/models/api-keys/:id', ctrl.modelApiEditKey)
modelApiRoutes.delete('/api/studio/models/api-keys/:id', ctrl.modelApiRevokeKey)
modelApiRoutes.get('/api/ekko-studio/models/v1/models', ctrl.modelApiModels)
modelApiRoutes.post('/api/ekko-studio/models/v1/responses', ctrl.modelApiResponses)
