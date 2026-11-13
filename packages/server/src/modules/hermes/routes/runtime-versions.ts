import Router from '@koa/router'
import * as ctrl from '../controllers/runtime-versions'
import { requireSuperAdmin } from '../../studio/public/auth'

export const runtimeVersionRoutes = new Router()

runtimeVersionRoutes.get('/api/hermes/runtime-versions', requireSuperAdmin, ctrl.status)
runtimeVersionRoutes.get('/api/hermes/runtime-versions/jobs', requireSuperAdmin, ctrl.jobs)
runtimeVersionRoutes.get('/api/hermes/runtime-versions/jobs/:id', requireSuperAdmin, ctrl.job)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/active-runtime', requireSuperAdmin, ctrl.activateRuntime)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/runtime-root', requireSuperAdmin, ctrl.selectRuntimeRoot)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/active-webui', requireSuperAdmin, ctrl.activateWebUi)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/runtime/download', requireSuperAdmin, ctrl.downloadRuntime)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/restart-webui', requireSuperAdmin, ctrl.restartWebUi)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/webui/download', requireSuperAdmin, ctrl.downloadWebUi)
runtimeVersionRoutes.delete('/api/hermes/runtime-versions/runtime/:version', requireSuperAdmin, ctrl.deleteRuntime)
runtimeVersionRoutes.delete('/api/hermes/runtime-versions/webui/:version', requireSuperAdmin, ctrl.deleteWebUi)
