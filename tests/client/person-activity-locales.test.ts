import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { personMessages } from '../../packages/client/src/i18n/person-messages'
import { supportedLocales } from '../../packages/client/src/i18n/messages'
import { personFlowStatusKey, type PersonFlowStatus } from '../../packages/client/src/utils/person-flow'

const stageStates: PersonFlowStatus[] = ['completed', 'active', 'running', 'queued', 'waiting_dependencies', 'waiting_user', 'waiting_person', 'waiting_approval', 'waiting_reply', 'interrupted', 'blocked']
const taskStates = ['idle', 'pending', 'queued', 'starting', 'stopping', 'running', 'waiting_person', 'waiting_user', 'waiting_approval', 'finished', 'failed', 'interrupted']
const keys = ['person.backgroundTasks', 'person.flows', ...stageStates.map(personFlowStatusKey), ...taskStates.map(state => `person.states.${state}`)]

describe('activity capsule native locale coverage', () => {
  it.each(supportedLocales)('has usable labels for every capsule state in %s without falling back to English', locale => {
    const messages = { person: personMessages[locale] }
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: false, messages: { [locale]: messages } })
    for (const key of new Set(keys)) {
      const raw = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], messages)
      expect(typeof raw, `${locale}:${key}`).toBe('string')
      expect(String(raw).trim().length, `${locale}:${key}`).toBeGreaterThan(0)
      expect(i18n.global.t(key), `${locale}:${key}`).not.toBe(key)
    }
  })
})
