import { configureModelGatewayAdapters } from '../modules/studio/public/model-gateway-adapters'
import { configureProviderHttp, createProviderHttpTransport } from '../modules/studio/public/provider-http'
import { configureProviderUpstream } from '../modules/studio/public/provider-upstream'
import { codingModelGatewayAdapters } from '../modules/coding-agents/public/model-gateway'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { authorizedModelProviderPreset } from '../../../ekko-agent/src/model/authorized-providers'

configureModelGatewayAdapters(codingModelGatewayAdapters)
configureProviderUpstream(resolveEkkoProviderRuntimeConfig)
configureProviderHttp(createProviderHttpTransport({
  createFetch: createEkkoAuthorizedProviderFetch,
  headers: (provider, apiKey) => authorizedModelProviderPreset(provider, apiKey)?.headers,
}))
