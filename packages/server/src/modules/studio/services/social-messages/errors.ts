export type SocialMessageErrorCode =
  | 'invalid_request'
  | 'platform_not_configured'
  | 'platform_send_failed'

export class SocialMessageError extends Error {
  constructor(
    public readonly code: SocialMessageErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'SocialMessageError'
  }
}

export function upstreamMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error || 'Unknown platform error')
}
