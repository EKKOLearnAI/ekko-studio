import { describe, expect, it } from 'vitest'
import ar from '../../packages/client/src/i18n/locales/ar'
import de from '../../packages/client/src/i18n/locales/de'
import en from '../../packages/client/src/i18n/locales/en'
import es from '../../packages/client/src/i18n/locales/es'
import fr from '../../packages/client/src/i18n/locales/fr'
import ja from '../../packages/client/src/i18n/locales/ja'
import ko from '../../packages/client/src/i18n/locales/ko'
import pt from '../../packages/client/src/i18n/locales/pt'
import ru from '../../packages/client/src/i18n/locales/ru'
import tr from '../../packages/client/src/i18n/locales/tr'
import zhTW from '../../packages/client/src/i18n/locales/zh-TW'
import zh from '../../packages/client/src/i18n/locales/zh'

const localeMessages: Record<string, Record<string, unknown>> = {
  ar,
  de,
  en,
  es,
  fr,
  ja,
  ko,
  pt,
  ru,
  zh,
  'zh-TW': zhTW,
}

const requiredPaths = [
  'sidebar.connections',
  'connections.title',
  'connections.tabs.app',
  'connections.tabs.mcu',
  'connections.app.subtitle',
  'connections.app.scanToAdd',
  'connections.app.purchaseAccess',
  'connections.app.downloadPaidDescription',
  'connections.app.viewMessages',
  'connections.app.scanModalTitle',
  'connections.app.lanConnection',
  'connections.app.cloudConnection',
  'connections.app.remainingTime',
  'connections.app.authorizationExpired',
  'connections.app.regenerate',
  'connections.app.refreshQr',
  'connections.app.cloudPending',
  'connections.app.authorizationFailed',
  'connections.app.accessFailureTitle',
  'connections.app.accessFailureMode',
  'connections.app.accessFailureDeviceName',
  'connections.app.accessFailureTime',
  'connections.app.accessModes.internal',
  'connections.app.accessModes.public_beta',
  'connections.app.accessModes.paid',
  'connections.app.accessModes.unknown',
  'connections.app.accessFailures.tokenExpired',
  'connections.app.accessFailures.paidAccountRequired',
  'connections.app.accessFailures.cloudSubscriptionRequired',
  'connections.app.accessFailures.appAccessExpired',
  'connections.app.accessFailures.required',
  'connections.app.accessFailures.invalid',
  'connections.app.accessFailures.expired',
  'connections.app.accessFailures.accountMismatch',
  'connections.app.accessFailures.deviceMismatch',
  'connections.app.accessFailures.unknown',
  'connections.app.deviceName',
  'connections.app.deviceBrand',
  'connections.app.deviceModel',
  'connections.app.deviceCode',
  'connections.app.connectionDetected',
  'connections.app.connectionType',
  'connections.app.authorizedUser',
  'connections.app.connectionTypes.lan',
  'connections.app.connectionTypes.cloud',
  'connections.app.connectionStatus',
  'connections.app.authorizationStatus',
  'connections.app.online',
  'connections.app.offline',
  'connections.app.active',
  'connections.app.expired',
  'connections.app.actions',
  'connections.app.delete',
  'connections.app.deleteConfirm',
  'connections.app.deleted',
  'connections.app.deleteFailed',
  'connections.app.empty',
  'connections.app.loadFailed',
  'mcuDevices.subtitle',
  'mcuDevices.refresh',
]

function getPath(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  ), messages)
}

describe('Device connections locale coverage', () => {
  it('defines remote device messages in every locale, including Turkish', () => {
    for (const [locale, messages] of Object.entries({ ...localeMessages, tr })) {
      for (const key of Object.keys(en.remoteDevices)) {
        expect(getPath(messages, `remoteDevices.${key}`), `${locale} missing remoteDevices.${key}`).toEqual(expect.any(String))
      }
    }
  })

  it('defines every new device connections message directly in every locale', () => {
    for (const [locale, messages] of Object.entries(localeMessages)) {
      for (const path of requiredPaths) {
        expect(getPath(messages, path), `${locale} missing ${path}`).toEqual(expect.any(String))
      }
    }
  })
})
