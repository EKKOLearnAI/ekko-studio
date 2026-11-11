export class PluginError extends Error {
  constructor(message: string, readonly code = 'PLUGIN_INVALID', readonly status = 400) { super(message) }
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
