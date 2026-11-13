import Router from '@koa/router'
import * as ctrl from '../controllers/realtime-agent'

/** Realtime direct terminal tools and Hermes fallback, registered before the proxy. */
export const realtimeAgentRoutes = new Router()

realtimeAgentRoutes.post('/api/studio/realtime/agent-query', ctrl.queryAgent)

realtimeAgentRoutes.post('/api/studio/realtime/terminal-command', ctrl.terminalCommand)
