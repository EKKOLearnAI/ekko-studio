import { setScriptReportJobInspector } from '../modules/studio/public/script-reports'
import { readNativeJob } from '../modules/hermes/services/script-reports/native-jobs'

// The script report importer fences every report against the native job as Hermes stores it now.
setScriptReportJobInspector(readNativeJob)
