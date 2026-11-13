import Router from '@koa/router'
import { claudeProxyMessages, claudeProxyModels } from '../controllers/claude-code-proxy'

export const claudeCodeProxyRoutes = new Router()

claudeCodeProxyRoutes.get('/api/claude-code-proxy/:key/v1/models', claudeProxyModels)
claudeCodeProxyRoutes.post('/api/claude-code-proxy/:key/v1/messages', claudeProxyMessages)
