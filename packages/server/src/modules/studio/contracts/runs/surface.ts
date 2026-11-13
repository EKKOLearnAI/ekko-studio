export const RUN_SURFACES = ['chat', 'workflow', 'group-chat', 'global-agent', 'api'] as const
export const RUN_MODES = ['scoped', 'global'] as const

export type RunSurface = typeof RUN_SURFACES[number]
export type RunMode = typeof RUN_MODES[number]

const RUN_SURFACE_SET = new Set<string>(RUN_SURFACES)
const RUN_MODE_SET = new Set<string>(RUN_MODES)

export function isRunSurface(value: unknown): value is RunSurface {
  return typeof value === 'string' && RUN_SURFACE_SET.has(value)
}

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && RUN_MODE_SET.has(value)
}
