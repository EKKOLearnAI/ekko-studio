import Router from '@koa/router'
import * as ctrl from '../controllers/script-reports'

export const scriptReportRoutes = new Router()

scriptReportRoutes.get('/api/hermes/script-reports/enrollments', ctrl.list)
scriptReportRoutes.post('/api/hermes/script-reports/enrollments', ctrl.enroll)
scriptReportRoutes.post('/api/hermes/script-reports/enrollments/:id/revoke', ctrl.revoke)
