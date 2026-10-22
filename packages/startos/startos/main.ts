import { i18n } from './i18n'
import { sdk } from './sdk'
import { storeJson } from './fileModels/store.json'
import { uiPort, dataMounts, runtimeEnv } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  const password = await storeJson.read((s) => s.adminPassword).const(effects)
  if (!password) return sdk.Daemons.of(effects)
  return sdk.Daemons.of(effects).addDaemon('studio', {
    subcontainer: sdk.SubContainer.of(
      effects,
      { imageId: 'studio' },
      dataMounts(),
      'studio',
    ),
    exec: { command: sdk.useEntrypoint(), env: runtimeEnv },
    ready: {
      display: i18n('Web Interface'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, uiPort, {
          successMessage: i18n('The web interface is ready'),
          errorMessage: i18n('The web interface is not ready'),
        }),
    },
    requires: [],
  })
})
