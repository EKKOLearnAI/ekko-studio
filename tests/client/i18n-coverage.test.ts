import { describe, expect, it, beforeAll } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

import { changelog } from '@/data/changelog'
import { mergeMessagesWithFallback, supportedLocales } from '@/i18n/messages'
import en from '@/i18n/locales/en'
import zh from '@/i18n/locales/zh'
import zhTW from '@/i18n/locales/zh-TW'
import ja from '@/i18n/locales/ja'
import ko from '@/i18n/locales/ko'
import fr from '@/i18n/locales/fr'
import es from '@/i18n/locales/es'
import de from '@/i18n/locales/de'
import pt from '@/i18n/locales/pt'
import ru from '@/i18n/locales/ru'
import ar from '@/i18n/locales/ar'
import { createI18n } from 'vue-i18n'

const SOURCE_ROOT = join(process.cwd(), 'packages/client/src')

const allMessages: Record<string, Record<string, unknown>> = { en }

const rawMessages: Record<string, Record<string, unknown>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  ko,
  fr,
  es,
  de,
  pt,
  ru,
  ar,
}

const messages: Record<string, Record<string, unknown>> = {}

it('defines task plan dynamic statuses and progress placeholders in every raw locale', () => {
  const keys = ['title', 'progress', 'pending', 'in_progress', 'completed', 'running', 'ended', 'interrupted', 'failed']
  for (const locale of supportedLocales) {
    const plan = rawMessages[locale].taskPlan as Record<string, string>
    expect(plan, locale).toBeDefined()
    expect(Object.keys(plan).sort(), locale).toEqual([...keys].sort())
    for (const key of keys) {
      expect(typeof plan[key], `${locale}: ${key}`).toBe('string')
      expect(plan[key].trim(), `${locale}: ${key}`).not.toBe('')
      if (locale !== 'en') expect(plan[key], `${locale}: ${key} copies English`).not.toBe(en.taskPlan[key as keyof typeof en.taskPlan])
    }
    expect(interpolationNames(plan.progress), locale).toEqual(['completed', 'total'])
  }
})

for (const [locale, localeMessages] of Object.entries(rawMessages)) {
  messages[locale] = locale === 'en'
    ? localeMessages
    : mergeMessagesWithFallback(en, localeMessages)
}

function walkFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(path, files)
    } else if (/\.(ts|vue)$/.test(entry.name) && !path.replace(/\\/g, '/').includes('/i18n/locales/')) {
      files.push(path)
    }
  }
  return files
}

function collectLiteralTranslationKeys(): string[] {
  const keys = new Set<string>()
  const translationCall = /(?:\b|\$)t\(\s*['"]([^'"]+)['"]/g

  for (const file of walkFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(translationCall)) {
      keys.add(match[1])
    }
  }

  for (const entry of changelog) {
    for (const change of entry.changes) {
      keys.add(change)
    }
  }

  return [...keys].sort()
}

function getPath(messages: Record<string, unknown>, key: string): unknown {
  let current: unknown = messages
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasPath(messages: Record<string, unknown>, key: string): boolean {
  return typeof getPath(messages, key) !== 'undefined'
}

function flattenLeafPaths(value: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>()
  if (!value || typeof value !== 'object') return leaves

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object') {
      for (const [childPath, childValue] of flattenLeafPaths(child, path)) {
        leaves.set(childPath, childValue)
      }
    } else {
      leaves.set(path, String(child ?? ''))
    }
  }
  return leaves
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
}

it('localizes all JEV messages and error codes without relying on English fallback', () => {
  const expected = flattenLeafPaths(en.jev)
  for (const locale of supportedLocales) {
    const actual = flattenLeafPaths(rawMessages[locale].jev)
    expect([...actual.keys()].sort(), locale).toEqual([...expected.keys()].sort())
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: rawMessages[locale] } })
    for (const [key, english] of expected) {
      const value = actual.get(key)!
      expect(value.trim(), `${locale}: jev.${key}`).not.toBe('')
      expect(interpolationNames(value), `${locale}: jev.${key}`).toEqual(interpolationNames(english))
      expect(() => i18n.global.t(`jev.${key}`, { model: 'jev-test', duration: '123' })).not.toThrow()
      if (locale !== 'en') expect(value, `${locale}: jev.${key} copies English`).not.toBe(english)
    }
  }
})

const SKILLS_USAGE_LOCALIZED_KEYS = [
  'sidebar.skillsUsage',
  'skillsUsage.title',
  'skillsUsage.subtitle',
  'skillsUsage.refresh',
  'skillsUsage.periodSelector',
  'skillsUsage.periodLabel',
  'skillsUsage.summary',
  'skillsUsage.totalActions',
  'skillsUsage.loads',
  'skillsUsage.edits',
  'skillsUsage.distinctSkills',
  'skillsUsage.topSkills',
  'skillsUsage.dailyTrend',
  'skillsUsage.periodSummary',
  'skillsUsage.skill',
  'skillsUsage.share',
  'skillsUsage.lastUsed',
  'skillsUsage.noData',
  'skillsUsage.loadFailed',
  'skillsUsage.otherSkills',
]

const SKILLS_USAGE_COMPACT_LABEL_LIMITS: Record<string, number> = {
  'skillsUsage.totalActions': 12,
  'skillsUsage.loads': 10,
  'skillsUsage.edits': 10,
  'skillsUsage.distinctSkills': 12,
  'skillsUsage.topSkills': 16,
  'skillsUsage.dailyTrend': 16,
  'skillsUsage.skill': 10,
  'skillsUsage.share': 10,
  'skillsUsage.lastUsed': 12,
  'skillsUsage.otherSkills': 16,
}

const APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS = [
  'chat.approvalAgree',
  'skills.writeApprovalTitle',
  'skills.writeApprovalDescription',
  'skills.writeApprovalEmpty',
  'skills.writeApprovalViewDiff',
  'skills.writeApprovalNoDiff',
  'skills.writeApprovalApprove',
  'skills.writeApprovalReject',
  'skills.writeApprovalPendingMemoryWrite',
  'skills.writeApprovalCurrentFile',
  'skills.writeApprovalPatchOldStringMissing',
  'settings.session.requireAuth',
  'settings.session.memoryWriteApproval',
  'settings.session.skillsWriteApproval',
]

const KANBAN_ARCHIVE_LOCALIZED_KEYS = [
  'kanban.board.defaultArchiveUnavailable',
  'kanban.action.archive',
  'kanban.action.archiveConfirm',
  'kanban.message.taskArchived',
]

const JOURNEY_DISTINCT_LOCALIZED_KEYS = [
  'journey.nodeKinds',
]

const PROVIDER_MODEL_REFRESH_LOCALIZED_KEYS = [
  'models.refreshModels',
  'models.restoreModels',
  'models.refreshModelsConfirmTitle',
  'models.refreshModelsConfirmContent',
  'models.refreshModelsConfirmAction',
  'models.refreshModelsSuccess',
  'models.refreshModelsFailed',
  'models.restoreModelsSuccess',
  'models.restoreModelsFailed',
]

const REASONING_EFFORT_LOCALIZED_KEYS = [
  'chat.reasoningEffort.tooltip',
  'chat.reasoningEffort.options.none',
  'chat.reasoningEffort.options.minimal',
  'chat.reasoningEffort.options.low',
  'chat.reasoningEffort.options.medium',
  'chat.reasoningEffort.options.high',
  'chat.reasoningEffort.options.xhigh',
  'chat.reasoningEffort.options.max',
  'chat.reasoningEffort.options.ultra',
]

const GROUP_CHAT_AGENT_LINK_LOCALIZED_KEYS = [
  'groupChat.agentLinkButton',
  'groupChat.agentOwner',
  'groupChat.agentLinkTitle',
  'groupChat.agentLinkDescription',
  'groupChat.agentLinkTargetUrl',
  'groupChat.agentLinkTargetRequired',
  'groupChat.agentLinkInvalidTarget',
  'groupChat.agentLinkOpenTarget',
  'groupChat.agentLinkPopupBlocked',
  'groupChat.agentLinkParentUnavailable',
  'groupChat.agentLinkParentUnconfirmed',
  'groupChat.agentLinkIncompleteConfiguration',
  'groupChat.agentLinkWaitingApproval',
  'groupChat.agentLinkApproved',
  'groupChat.agentLinkConnected',
  'groupChat.agentLinkError',
  'groupChat.agentLinkRejected',
  'groupChat.agentLinkExpired',
  'groupChat.agentLinkPairingCode',
  'groupChat.agentLinkPairingCodeHint',
  'groupChat.agentLinkCopyCode',
  'groupChat.agentLinkAuthorizeTitle',
  'groupChat.agentLinkAuthorizeDescription',
  'groupChat.agentLinkRequestConnection',
  'groupChat.agentLinkOrPairingCode',
  'groupChat.agentLinkPairingCodePlaceholder',
  'groupChat.agentLinkConnect',
  'groupChat.agentLinkSecurityHint',
  'groupChat.agentLinkLoadFailed',
  'groupChat.agentLinkConnectFailed',
  'groupChat.agentLinkInvalidPairingCode',
  'groupChat.agentLinkClose',
  'groupChat.agentLinkApprovalMismatch',
  'groupChat.guestAgentsDisabled',
  'groupChat.guestAgentSettings',
  'groupChat.allowGuestAgents',
  'groupChat.maxGuestAgentsPerMember',
  'groupChat.ownerApprovalHint',
  'groupChat.agentPairingRequestTitle',
  'groupChat.agentPairingRequestDescription',
  'groupChat.approveAgent',
  'groupChat.rejectAgent',
  'groupChat.agentPairingApproved',
  'groupChat.agentPairingRejected',
  'groupChat.allAgents',
]

const PLATFORM_SETTINGS_LOCALE_SPECIFIC_LOCALIZED_KEYS: Record<string, string[]> = {
  de: ['platform.qqAppId', 'platform.qqAppSecret'],
  ja: ['platform.homeserver', 'platform.accountId'],
  ko: ['platform.botToken', 'platform.accessToken', 'platform.homeserver', 'platform.weixinToken', 'platform.accountId'],
  ru: ['platform.weixinToken'],
}

const WORKFLOW_SCHEDULE_LOCALIZED_KEYS = [
  'workflow.schedule.title',
  'workflow.schedule.manage',
  'workflow.schedule.createTitle',
  'workflow.schedule.editTitle',
  'workflow.schedule.create',
  'workflow.schedule.save',
  'workflow.schedule.edit',
  'workflow.schedule.delete',
  'workflow.schedule.deleteConfirm',
  'workflow.schedule.deleted',
  'workflow.schedule.enable',
  'workflow.schedule.disable',
  'workflow.schedule.enabled',
  'workflow.schedule.disabled',
  'workflow.schedule.empty',
  'workflow.schedule.frequency',
  'workflow.schedule.selectFrequency',
  'workflow.schedule.cron',
  'workflow.schedule.cronPlaceholder',
  'workflow.schedule.timezone',
  'workflow.schedule.timezonePlaceholder',
  'workflow.schedule.initialInput',
  'workflow.schedule.initialInputPlaceholder',
  'workflow.schedule.startNodes',
  'workflow.schedule.startNodesPlaceholder',
  'workflow.schedule.timeout',
  'workflow.schedule.timeoutPlaceholder',
  'workflow.schedule.policies',
  'workflow.schedule.lastScheduled',
  'workflow.schedule.nextRun',
  'workflow.schedule.lastRun',
  'workflow.schedule.never',
  'workflow.schedule.loadFailed',
  'workflow.schedule.saveFailed',
  'workflow.schedule.saved',
  'workflow.schedule.deleteFailed',
  'workflow.schedule.required',
  'workflow.schedule.reset',
  'workflow.schedule.presets.everyMinute',
  'workflow.schedule.presets.every5Minutes',
  'workflow.schedule.presets.every30Minutes',
  'workflow.schedule.presets.hourly',
  'workflow.schedule.presets.daily',
  'workflow.schedule.presets.weekly',
  'workflow.schedule.presets.monthly',
  'workflow.schedule.presets.custom',
]

const PLATFORM_SETTINGS_LOCALIZED_KEYS = [
  'platform.requireMention',
  'platform.requireMentionGroup',
  'platform.requireMentionChannel',
  'platform.requireMentionRoom',
  'platform.reactions',
  'platform.reactionsHint',
  'platform.freeResponseChats',
  'platform.freeResponseChatsHint',
  'platform.freeResponseChannels',
  'platform.freeResponseChannelsHint',
  'platform.freeResponseRooms',
  'platform.freeResponseRoomsHint',
  'platform.mentionPatterns',
  'platform.mentionPatternsHint',
  'platform.autoThread',
  'platform.autoThreadHint',
  'platform.autoThreadHintRoom',
  'platform.dmMentionThreads',
  'platform.dmMentionThreadsHint',
  'platform.allowBots',
  'platform.allowBotsHint',
  'platform.allowedChannels',
  'platform.allowedChannelsHint',
  'platform.ignoredChannels',
  'platform.ignoredChannelsHint',
  'platform.noThreadChannels',
  'platform.noThreadChannelsHint',
  'platform.exclusiveTokenWarning',
  'platform.botTokenHint',
  'platform.accessTokenHint',
  'platform.homeserverHint',
  'platform.matrixUserId',
  'platform.matrixUserIdHint',
  'platform.matrixPassword',
  'platform.matrixPasswordHint',
  'platform.appIdHint',
  'platform.appSecretHint',
  'platform.encryptKey',
  'platform.encryptKeyHint',
  'platform.verificationToken',
  'platform.verificationTokenHint',
  'platform.clientIdHint',
  'platform.clientSecretHint',
  'platform.cardTemplateId',
  'platform.cardTemplateIdHint',
  'platform.botIdHint',
  'platform.wecomSecretHint',
  'platform.waEnabled',
  'platform.waEnabledHint',
  'platform.weixinTokenHint',
  'platform.accountIdHint',
  'platform.qrLogin',
  'platform.qrRelogin',
  'platform.qrFetching',
  'platform.qrScanHint',
  'platform.qrScanedHint',
  'platform.qqAppIdHint',
  'platform.qqAppSecretHint',
  'platform.qqMarkdown',
  'platform.qqMarkdownHint',
  'platform.qqSandbox',
  'platform.qqSandboxHint',
  'platform.qqQrScanHint',
  'platform.allowedUsers',
  'platform.allowedUsersHint',
  'platform.allowAllUsers',
  'platform.allowAllUsersHint',
]

function labelLength(value: unknown): number {
  return typeof value === 'string' ? Array.from(value.replace(/\{[^}]+\}/g, '')).length : Infinity
}

describe('i18n locale coverage', () => {
  const ALLOWED_MISSING_KEYS = new Set([
    'chat.sessionNotFound',
  ])

  beforeAll(() => {
    for (const l of supportedLocales) {
      if (l !== 'en' && messages[l]) {
        allMessages[l] = messages[l]
      }
    }
  })

  it('defines every statically referenced translation key in the English source locale', () => {
    const missing = collectLiteralTranslationKeys()
      .filter((key) => !hasPath(en, key))
      .filter((key) => !ALLOWED_MISSING_KEYS.has(key))

    expect(missing).toEqual([])
  })

  it('defines every statically referenced translation key in effective runtime messages', () => {
    const requiredKeys = collectLiteralTranslationKeys()
    const missing = Object.entries(allMessages).flatMap(([locale, localeMessages]) =>
      requiredKeys
        .filter((key) => !hasPath(localeMessages, key))
        .filter((key) => !ALLOWED_MISSING_KEYS.has(key))
        .map((key) => `${locale}: ${key}`),
    )

    expect(missing).toEqual([])
  })

  it('fully defines the raw group-chat namespace in every locale', () => {
    const englishGroupChat = flattenLeafPaths(en.groupChat)
    const issues = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      const localizedGroupChat = flattenLeafPaths(localeMessages.groupChat)
      const missing = [...englishGroupChat.keys()]
        .filter(key => !localizedGroupChat.has(key))
        .map(key => `${locale}: missing groupChat.${key}`)
      const extra = [...localizedGroupChat.keys()]
        .filter(key => !englishGroupChat.has(key))
        .map(key => `${locale}: extra groupChat.${key}`)
      const interpolationMismatches = [...englishGroupChat.entries()].flatMap(([key, englishValue]) => {
        const localizedValue = localizedGroupChat.get(key)
        if (typeof localizedValue === 'undefined') return []
        const expected = interpolationNames(englishValue)
        const actual = interpolationNames(localizedValue)
        return expected.join('|') === actual.join('|')
          ? []
          : [`${locale}: groupChat.${key} placeholders ${actual.join(',')} != ${expected.join(',')}`]
      })
      return [...missing, ...extra, ...interpolationMismatches]
    })

    expect(issues).toEqual([])
  })

  it('compiles every changelog message in every locale', () => {
    for (const [locale, localeMessages] of Object.entries(rawMessages)) {
      const i18n = createI18n({
        legacy: false,
        locale,
        fallbackLocale: false,
        messages: { [locale]: localeMessages },
      })

      for (const entry of changelog) {
        for (const change of entry.changes) {
          expect(() => i18n.global.t(change), `${locale}: ${change}`).not.toThrow()
        }
      }
    }
  })

  it('localizes Skills Usage page copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return SKILLS_USAGE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes approval and write-gate copy in every non-English locale instead of falling back to English', () => {
    const englishMessages = messages.en
    const untranslated = Object.entries(messages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return APPROVAL_AND_WRITE_GATE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(englishMessages, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes Kanban archive copy in every raw non-English locale', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return KANBAN_ARCHIVE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes Journey node-kind copy in every raw non-English locale', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return JOURNEY_DISTINCT_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes provider model refresh copy in every raw non-English locale', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return PROVIDER_MODEL_REFRESH_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('defines every reasoning-effort option in every raw locale', () => {
    const missing = Object.entries(rawMessages).flatMap(([locale, localeMessages]) =>
      REASONING_EFFORT_LOCALIZED_KEYS
        .filter(key => !hasPath(localeMessages, key))
        .map(key => `${locale}: ${key}`),
    )

    expect(missing).toEqual([])
  })

  it('localizes Agent linking and pairing copy in every raw non-English locale', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return GROUP_CHAT_AGENT_LINK_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('localizes every Workflow Schedule string in every raw non-English locale instead of copying English', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      return WORKFLOW_SCHEDULE_LOCALIZED_KEYS.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue !== 'string' || !localeValue.trim()) return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key} copies English`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('uses Chinese Schedule translations for the customer-facing entry points', () => {
    expect(getPath(zh, 'workflow.schedule.manage')).toBe('管理定时计划')
    expect(getPath(zh, 'workflow.schedule.timezone')).toBe('时区')
    expect(getPath(zhTW, 'workflow.schedule.manage')).toBe('管理排程')
    expect(getPath(zhTW, 'workflow.schedule.timezone')).toBe('時區')
  })

  it('localizes platform settings copy in every raw non-English locale instead of falling back to English', () => {
    const untranslated = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []

      const localeKeys = [
        ...PLATFORM_SETTINGS_LOCALIZED_KEYS,
        ...(PLATFORM_SETTINGS_LOCALE_SPECIFIC_LOCALIZED_KEYS[locale] || []),
      ]

      return localeKeys.flatMap((key) => {
        const localeValue = getPath(localeMessages, key)
        if (typeof localeValue === 'undefined') return [`${locale}: ${key} missing`]
        return localeValue === getPath(en, key) ? [`${locale}: ${key}`] : []
      })
    })

    expect(untranslated).toEqual([])
  })

  it('defines every Webhook settings string in every raw non-English locale', () => {
    const englishWebhooks = flattenLeafPaths(en.settings.webhooks)
    const issues = Object.entries(rawMessages).flatMap(([locale, localeMessages]) => {
      if (locale === 'en') return []
      const localizedWebhooks = flattenLeafPaths(
        (localeMessages.settings as Record<string, unknown>)?.webhooks,
      )
      return [...englishWebhooks.entries()].flatMap(([key, englishValue]) => {
        const localeValue = localizedWebhooks.get(key)
        if (localeValue === undefined) return [`${locale}: settings.webhooks.${key} missing`]
        return interpolationNames(localeValue).join(',') === interpolationNames(englishValue).join(',')
          ? []
          : [`${locale}: settings.webhooks.${key} interpolation mismatch`]
      })
    })

    expect(issues).toEqual([])
  })

  it('keeps Skills Usage summary and table labels compact across locales', () => {
    const oversized = Object.entries(messages).flatMap(([locale, localeMessages]) =>
      Object.entries(SKILLS_USAGE_COMPACT_LABEL_LIMITS).flatMap(([key, maxLength]) => {
        const localeValue = getPath(localeMessages, key)
        return labelLength(localeValue) > maxLength
          ? [`${locale}: ${key} (${labelLength(localeValue)} > ${maxLength})`]
          : []
      }),
    )

    expect(oversized).toEqual([])
  })

  it('keeps the coverage scanner rooted in client source files', () => {
    expect(relative(process.cwd(), SOURCE_ROOT)).toBe(join('packages', 'client', 'src'))
  })
})
