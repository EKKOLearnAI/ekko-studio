import Router from '@koa/router'
import * as ctrl from '../controllers/chat-run'
import { requestClarification } from '../controllers/clarifications'
import { updateTaskPlan } from '../controllers/task-plans'
export { getChatRunServer, setChatRunServer } from '../public/chat-run'

export const chatRunRoutes = new Router()

chatRunRoutes.post('/api/studio/task-plans/update', updateTaskPlan)
chatRunRoutes.post('/api/studio/clarifications/request', requestClarification)

chatRunRoutes.post('/api/studio/chat-run/runs', ctrl.runOnce)
chatRunRoutes.post('/api/studio/mobile-calendar/request', ctrl.requestMobileCalendar)
chatRunRoutes.post('/api/studio/mobile-location/request', ctrl.requestMobileLocation)
chatRunRoutes.post('/api/studio/mobile-health/request', ctrl.requestMobileHealth)
