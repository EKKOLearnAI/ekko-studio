import { config } from '../modules/studio/public/config'
import * as hermesCli from '../modules/hermes/services/runtime/cli'
import * as systemInfo from '../modules/studio/public/system-info'

systemInfo.configureSystemInfo({
  getAppHome: () => config.appHome,
  getHermesVersion: () => hermesCli.getVersion(),
})

export * from '../modules/studio/public/system-info'
