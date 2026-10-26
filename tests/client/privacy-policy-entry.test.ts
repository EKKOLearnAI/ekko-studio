import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('privacy notice navigation', () => {
  it('provides a safe public policy link from privacy settings', () => {
    const source = readFileSync(resolve('packages/client/src/components/hermes/settings/PrivacySettings.vue'), 'utf8')
    expect(source).toContain('https://github.com/EKKOLearnAI/ekko-studio/blob/main/PRIVACY.md')
    expect(source).toContain('rel="noopener noreferrer"')
    expect(source).toContain("t('settings.privacy.policy')")
  })

  it('defines the policy label in every locale', () => {
    for (const locale of readdirSync(resolve('packages/client/src/i18n/locales')).filter(name => name.endsWith('.ts'))) {
      const source = readFileSync(resolve('packages/client/src/i18n/locales', locale), 'utf8')
      expect(source, locale).toMatch(/privacy: \{\s+policy: '[^']+'/)
    }
  })
})
