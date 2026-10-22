import { sdk } from '../sdk'
import { setAdminPassword } from './setAdminPassword'
export const actions = sdk.Actions.of().addAction(setAdminPassword)
