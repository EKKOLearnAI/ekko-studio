import Router from '@koa/router'
import { codexProxyModels, codexProxyResponses, antigravityProxyGenerate, codingAgentProxyChatCompletions } from '../controllers/codex-proxy'

export const codexProxyRoutes = new Router()

codexProxyRoutes.get('/api/codex-proxy/:key/v1/models', codexProxyModels)
codexProxyRoutes.post('/api/codex-proxy/:key/v1/responses', codexProxyResponses)
codexProxyRoutes.post('/api/codex-proxy/:key/v1/chat/completions', codingAgentProxyChatCompletions)

codexProxyRoutes.post('/api/codex-proxy/:key/gemini/v1beta/models/:operation', antigravityProxyGenerate)
