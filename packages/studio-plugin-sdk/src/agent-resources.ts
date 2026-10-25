/** Native paths declared by the plugin; Studio owns discovery and file operations. */
export interface AgentResourceLocation {
  id: string
  name: string
  path: string
  scope: 'global' | 'scoped' | 'workspace' | 'shared' | 'builtin'
  readOnly: boolean
}

export interface AgentResourceLocations {
  /** Each root may contain multiple skills. Omitted means unsupported; [] means empty. */
  skills?: AgentResourceLocation[]
  /** Multiple individual files and/or directories, preserving their source identities. */
  configs?: Array<AgentResourceLocation & { kind: 'file' | 'directory'; format?: string }>
}
