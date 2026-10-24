export const STUDIO_ERROR_CODES = [
  'INVALID_ARGUMENT', 'FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT',
  'SYSTEM_PLUGIN_PROTECTED', 'PLUGIN_UNAVAILABLE', 'PLUGIN_VERSION_INCOMPATIBLE',
  'REGISTRATION_CONFLICT', 'CAPABILITY_UNSUPPORTED', 'RUNTIME_UNAVAILABLE',
  'CANCELLED', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'RUN_FINALIZING', 'EVENT_CURSOR_EXPIRED', 'INTERNAL',
] as const
export type StudioErrorCode = typeof STUDIO_ERROR_CODES[number]

export interface StudioErrorData {
  code: StudioErrorCode
  message: string
  retryable: boolean
}

export class StudioError extends Error implements StudioErrorData {
  constructor(
    public readonly code: StudioErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'StudioError'
  }

  toJSON(): StudioErrorData {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}

/** A separately bundled plugin has its own SDK class identity. Only copy the
 * public, bounded error fields; never invoke plugin-provided serialization. */
export function serializeStudioError(error: unknown, fallbackMessage: string): StudioErrorData {
  try {
    if (error && typeof error === 'object') {
      const field = (key: string): unknown => Object.getOwnPropertyDescriptor(error, key)?.value
      const name = field('name'), code = field('code'), message = field('message'), retryable = field('retryable')
      if (name === 'StudioError' && STUDIO_ERROR_CODES.includes(code as StudioErrorCode)
        && typeof message === 'string' && message.length <= 4096 && typeof retryable === 'boolean') {
        return { code: code as StudioErrorCode, message, retryable }
      }
    }
  } catch { /* A throwing proxy is an ordinary private implementation error. */ }
  return { code: 'INTERNAL', message: fallbackMessage, retryable: false }
}
