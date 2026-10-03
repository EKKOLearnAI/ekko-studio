import type { EkkoConfigStore } from '../config-store'
import type { EkkoModelAuthorizationManager } from './authorization'
import { resolveConfiguredModelProvider } from './provider-config'
import { createModelClient } from './registry'
import type {
  ModelCapabilities,
  ModelClient,
  ModelClientOptions,
  ModelEvent,
  ModelRequest,
  ModelRequestStyle,
  ModelResponse,
} from './types'

export interface AuthorizedModelClientOptions {
  config: EkkoConfigStore
  authorizations: EkkoModelAuthorizationManager
  provider: string
  model?: string
  clientOptions?: ModelClientOptions
}

/** Model client decorator that refreshes OAuth credentials before each call. */
export class AuthorizedModelClient implements ModelClient {
  get supportsContextTransport(): boolean { return this.initialClient.supportsContextTransport === true }
  get defaultModel(): string | undefined { return this.model ?? this.initialClient.defaultModel }
  readonly provider: string
  readonly requestStyle: ModelRequestStyle
  readonly capabilities: ModelCapabilities

  private readonly config: EkkoConfigStore
  private readonly authorizations: EkkoModelAuthorizationManager
  private readonly model?: string
  private readonly clientOptions: ModelClientOptions
  private readonly initialClient: ModelClient

  constructor(options: AuthorizedModelClientOptions) {
    this.config = options.config
    this.authorizations = options.authorizations
    this.provider = options.provider
    this.model = options.model
    this.clientOptions = options.clientOptions || {}
    this.initialClient = createModelClient(resolveConfiguredModelProvider({
      config: this.config.read(),
      provider: this.provider,
      model: this.model,
    }), this.clientOptions)
    this.requestStyle = this.initialClient.requestStyle
    this.capabilities = this.initialClient.capabilities
  }

  requestTarget(request: ModelRequest): string {
    return this.initialClient.requestTarget?.(request) || ''
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    return (await this.currentClient()).create(request)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const client = await this.currentClient()
    for await (const event of client.stream(request)) yield event
  }

  private async currentClient(): Promise<ModelClient> {
    const credentials = await this.authorizations.resolve(this.provider, this.model)
    const providerConfig = resolveConfiguredModelProvider({
      config: this.config.read(),
      provider: this.provider,
      model: this.model,
      apiKey: credentials.accessToken,
      baseUrl: credentials.baseUrl,
      apiMode: credentials.apiMode,
    })
    return createModelClient(providerConfig, this.clientOptions)
  }
}
