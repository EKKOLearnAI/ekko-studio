export interface WeChatWorkspaceInput {
  platformProfileId: number
  displayName: string
  avatarUrl?: string | null
  apiBase: string
  apiKey: string
  models: string[]
}

interface WeChatWorkspaceAdapter {
  exists: (name: string) => boolean
  ensure: (input: WeChatWorkspaceInput) => Promise<string | null>
}

let adapter: WeChatWorkspaceAdapter | undefined

export function configureWeChatWorkspace(value: WeChatWorkspaceAdapter): void {
  adapter = value
}

export function existingWeChatWorkspace(name: string): boolean {
  return adapter?.exists(name) ?? false
}

export function ensureWeChatWorkspace(input: WeChatWorkspaceInput): Promise<string | null> {
  return adapter?.ensure(input) ?? Promise.resolve(null)
}

export function weChatWorkspaceName(platformId: number): string {
  return `u_${platformId}`
}
