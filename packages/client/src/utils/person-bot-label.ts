import { uiLocale } from '@/i18n/locale-state'

export function personBotLabel(bot: { type: string; name: string }, locale = uiLocale.value) {
  return /^zh(?:[-_]|$)/i.test(locale) ? bot.name : bot.type
}
