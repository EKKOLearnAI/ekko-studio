import Router from '@koa/router'
import * as ctrl from '../controllers/config'

export const configRoutes = new Router()

configRoutes.get('/api/hermes/config', ctrl.getConfig)
configRoutes.put('/api/hermes/config', ctrl.updateConfig)
configRoutes.get('/api/hermes/config/auxiliary-models', ctrl.getAuxiliaryModels)
configRoutes.put('/api/hermes/config/auxiliary-models', ctrl.updateAuxiliaryModels)
configRoutes.get('/api/hermes/config/delegation-model', ctrl.getDelegationModel)
configRoutes.put('/api/hermes/config/delegation-model', ctrl.updateDelegationModel)
configRoutes.get('/api/hermes/config/fallback-providers', ctrl.getFallbackProviders)
configRoutes.put('/api/hermes/config/fallback-providers', ctrl.updateFallbackProviders)
configRoutes.get('/api/hermes/config/moa', ctrl.getMoaConfig)
configRoutes.put('/api/hermes/config/moa', ctrl.updateMoaConfig)
configRoutes.put('/api/hermes/config/credentials', ctrl.updateCredentials)
configRoutes.delete('/api/hermes/config/credentials/:platform', ctrl.clearCredentials)
