/** Studio-owned title policy; coding runtimes must not duplicate model or DB logic. */
export {
  generateSessionAutoTitle,
  prepareSessionAutoTitle,
  type SessionAutoTitleOptions,
} from '../services/chat-run/session-auto-title'
export type { SessionTitleSnapshot } from '../repositories/session-title-store'
