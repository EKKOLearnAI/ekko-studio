/** Explicit initial support boundary; do not infer features from CLI flags alone. */
export const ANTIGRAVITY_CAPABILITIES = {
  modes: ['global'],
  installation: 'manual',
  automaticUpdates: false,
  nativeResume: true,
  streaming: true,
  tools: true,
  mcp: true,
  skills: true,
  images: false,
  nativeCompact: false,
  overflowRecovery: false,
  memoryExport: false,
  contextSnapshot: false,
} as const
