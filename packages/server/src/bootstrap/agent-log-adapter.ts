import { existsSync } from 'fs'
import { join } from 'path'
import {
  EKKO_LOG_FILE_NAME,
  EkkoDirectoryManager,
  EkkoFileLogReader,
} from '../../../ekko-agent/src'
import { config } from '../modules/studio/public/config'
import { configureAgentLogs } from '../modules/studio/public/agent-logs'
import {
  listLogFiles,
  readLogs,
} from '../modules/hermes/services/runtime/cli'

configureAgentLogs({
  listPrimaryAgentLogFiles: listLogFiles,
  readPrimaryAgentLogs: readLogs,
  getEkkoLogSource: profile => {
    try {
      const directory = new EkkoDirectoryManager(config.appHome).profileLogsPath(profile)
      const filePath = join(directory, EKKO_LOG_FILE_NAME)
      if (!existsSync(filePath)) return null
      const reader = new EkkoFileLogReader({ directory })
      return {
        filePath: reader.filePath,
        query: options => reader.query(options as any),
      }
    } catch {
      return null
    }
  },
})
