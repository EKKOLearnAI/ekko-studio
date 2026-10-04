/** Studio integration support; images are opened through native viewing tools. */
export const ANTIGRAVITY_CAPABILITIES = {
  modes: ['global', 'scoped'],
  installation: 'manual',
  automaticUpdates: false,
  nativeResume: true,
  streaming: true,
  tools: true,
  mcp: true,
  skills: true,
  images: true,
  nativeCompact: false,
  overflowRecovery: false,
  memoryExport: false,
  contextSnapshot: false,
} as const
