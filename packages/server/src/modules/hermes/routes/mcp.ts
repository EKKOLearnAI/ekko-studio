import Router from '@koa/router'
import * as ctrl from '../controllers/mcp'

export const mcpRoutes = new Router()

mcpRoutes.get('/api/hermes/mcp/servers', ctrl.listServers)
mcpRoutes.post('/api/hermes/mcp/servers', ctrl.addServer)
mcpRoutes.patch('/api/hermes/mcp/servers/:name', ctrl.updateServer)
mcpRoutes.delete('/api/hermes/mcp/servers/:name', ctrl.removeServer)
mcpRoutes.post('/api/hermes/mcp/servers/:name/test', ctrl.testServer)
mcpRoutes.get('/api/hermes/mcp/tools', ctrl.listTools)
mcpRoutes.post('/api/hermes/mcp/reload', ctrl.reloadMcp)
