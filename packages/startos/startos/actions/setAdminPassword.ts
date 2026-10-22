import { utils } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
import { dataMounts, passwordBootstrap, runtimeEnv } from '../utils'

export const setAdminPassword = sdk.Action.withoutInput(
  'set-admin-password',
  async ({ effects }) => ({
    name: i18n('Set Admin Password'),
    description: i18n(
      'Generate and apply a new password for the admin account.',
    ),
    warning: (await storeJson.read((s) => s.adminPassword).const(effects))
      ? i18n('Replaces the current admin password.')
      : null,
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
  }),
  async ({ effects }) => {
    const adminPassword = utils.getDefaultString({
      charset: 'a-z,A-Z,0-9',
      len: 32,
    })
    // A failed/interrupted reset must keep the public daemon blocked.
    await storeJson.merge(effects, { adminPassword: null })
    await sdk.SubContainer.withTemp(
      effects,
      { imageId: 'studio' },
      dataMounts(),
      'credential-setup',
      async (sub) => {
        await sub.execFail(
          ['node', '--input-type=module', '-e', passwordBootstrap],
          {
            env: { ...runtimeEnv, STARTOS_ADMIN_PASSWORD: adminPassword },
            timeout: 120000,
          },
        )
      },
    )
    await storeJson.merge(effects, { adminPassword })
    return {
      version: '1',
      title: i18n('Login Credentials'),
      message: i18n(
        'Save this password, start the service, and sign in as admin.',
      ),
      result: {
        type: 'group',
        value: [
          {
            type: 'single',
            name: i18n('Username'),
            description: null,
            value: 'admin',
            masked: false,
            copyable: true,
            qr: false,
            launchable: false,
          },
          {
            type: 'single',
            name: i18n('Password'),
            description: null,
            value: adminPassword,
            masked: true,
            copyable: true,
            qr: false,
            launchable: false,
          },
        ],
      },
    }
  },
)
