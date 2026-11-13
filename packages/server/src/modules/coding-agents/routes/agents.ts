import { requireAdmin, requireSuperAdmin } from '../../studio/public/auth'
import Router from '@koa/router'
import * as ctrl from '../controllers/agents'
import { models } from '../controllers/models'
import * as presets from '../controllers/dsh-agent-presets'
import * as plugins from '../controllers/dsh-plugins'

export const codingAgentRoutes = new Router()

// Authenticated chat users can select modes without access to native configuration.
codingAgentRoutes.get('/api/coding-agents/dsh/session-presets', presets.choices)

codingAgentRoutes.get('/api/coding-agents/dsh/agent-presets', requireSuperAdmin, presets.list)
codingAgentRoutes.post('/api/coding-agents/dsh/agent-presets', requireSuperAdmin, presets.copy)
codingAgentRoutes.get('/api/coding-agents/dsh/agent-presets/:presetId', requireSuperAdmin, presets.read)
codingAgentRoutes.delete('/api/coding-agents/dsh/agent-presets/:presetId', requireSuperAdmin, presets.remove)
codingAgentRoutes.put('/api/coding-agents/dsh/agent-presets/:presetId/default', requireSuperAdmin, presets.makeDefault)
codingAgentRoutes.post('/api/coding-agents/dsh/agent-presets/:presetId/location', requireSuperAdmin, presets.openLocation)

codingAgentRoutes.get('/api/coding-agents/dsh/plugin-inventory', requireSuperAdmin, plugins.inventory)
codingAgentRoutes.post('/api/coding-agents/dsh/web-plugins', requireSuperAdmin, plugins.change)
codingAgentRoutes.post('/api/coding-agents/dsh/ui-session', requireSuperAdmin, plugins.openUi)
codingAgentRoutes.delete('/api/coding-agents/dsh/ui-session/:id', requireSuperAdmin, plugins.closeUi)

codingAgentRoutes.get('/api/coding-agents/update-policies', requireAdmin, ctrl.updatePolicies)
codingAgentRoutes.put('/api/coding-agents/:id/update-policy', requireAdmin, ctrl.setUpdatePolicy)
codingAgentRoutes.get('/api/coding-agents', ctrl.status)
codingAgentRoutes.get('/api/coding-agents/models', models)
codingAgentRoutes.post('/api/coding-agents/:id/install', ctrl.install)
codingAgentRoutes.post('/api/coding-agents/:id/check-update', ctrl.checkUpdate)
codingAgentRoutes.post('/api/coding-agents/:id/launch/prepare', ctrl.prepareLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/launch/native', ctrl.nativeLaunch)
codingAgentRoutes.post('/api/coding-agents/:id/runs', ctrl.startRun)
codingAgentRoutes.post('/api/coding-agents/runs/:sessionId/input', ctrl.sendRunInput)
codingAgentRoutes.delete('/api/coding-agents/runs/:sessionId', ctrl.stopRun)
codingAgentRoutes.delete('/api/coding-agents/:id', ctrl.remove)
codingAgentRoutes.get('/api/coding-agents/:id/config-files/:key', ctrl.readConfigFile)
codingAgentRoutes.put('/api/coding-agents/:id/config-files/:key', ctrl.writeConfigFile)
codingAgentRoutes.get('/api/coding-agents/:id/mcp/servers', ctrl.listMcpServers)
codingAgentRoutes.post('/api/coding-agents/:id/mcp/servers', ctrl.addMcpServer)
codingAgentRoutes.patch('/api/coding-agents/:id/mcp/servers/:name', ctrl.updateMcpServer)
codingAgentRoutes.delete('/api/coding-agents/:id/mcp/servers/:name', ctrl.removeMcpServer)
codingAgentRoutes.post('/api/coding-agents/:id/mcp/servers/:name/test', ctrl.testMcpServer)
