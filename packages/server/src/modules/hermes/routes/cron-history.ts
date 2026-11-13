import Router from '@koa/router'
import * as ctrl from '../controllers/cron-history'

export const cronHistoryRoutes = new Router()

cronHistoryRoutes.get('/api/cron-history', ctrl.listRuns)
cronHistoryRoutes.get('/api/cron-history/:jobId/:fileName', ctrl.readRun)
