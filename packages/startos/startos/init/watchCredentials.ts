import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
import { setAdminPassword } from '../actions/setAdminPassword'

export const watchCredentials = sdk.setupOnInit(async (effects) => {
  const password = await storeJson.read((s) => s.adminPassword).const(effects)
  if (!password) {
    await sdk.action.createOwnTask(effects, setAdminPassword, 'critical', {
      reason: i18n('Set the admin password before starting Ekko Studio.'),
    })
  }
})
