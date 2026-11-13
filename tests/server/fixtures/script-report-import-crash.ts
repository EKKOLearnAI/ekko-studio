// Runs one real script report import pass in its own process and SIGKILLs that process at a
// durability boundary, so the parent test can read back what actually survived on disk:
//   SCRIPT_REPORT_CRASH_AT=commit   just before the inbox transaction commits
//   SCRIPT_REPORT_CRASH_AT=receipt  after the inbox commit, before the invocation receipt is written
//   SCRIPT_REPORT_CRASH_AT=ack      after the receipt, before the spool entry is renamed away
//   SCRIPT_REPORT_CRASH_AT=sweep    while removing an acknowledged entry, after final.json is gone
// Uses the file database named by HERMES_WEB_UI_TEST_DB_DIR and the homes in the environment.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const crashAt = process.env.SCRIPT_REPORT_CRASH_AT
const die = () => process.kill(process.pid, 'SIGKILL')
if (crashAt === 'ack') {
  const real = fs.renameSync
  ;(fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).includes('/spool/') && String(to).includes('/.ack-')) die()
    return real(from, to)
  }
  syncBuiltinESMExports()
}
if (crashAt === 'sweep') {
  // A recursive removal cut short: final.json is already gone, the folder is not.
  const real = fs.rmSync
  ;(fs as any).rmSync = (path: fs.PathLike, options?: fs.RmOptions) => {
    if (String(path).includes('/spool/')) {
      try { fs.unlinkSync(`${String(path)}/final.json`) } catch { /* not a report folder */ }
      die()
    }
    return real(path, options)
  }
  syncBuiltinESMExports()
}
if (crashAt === 'commit') {
  const real = DatabaseSync.prototype.exec
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql === 'COMMIT' && (globalThis as any).__importing) die()
    return real.call(this, sql)
  }
}
if (crashAt === 'receipt') {
  const real = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (sql.includes('INSERT INTO script_report_invocations') && (globalThis as any).__importing) die()
    return real.call(this, sql)
  }
}

const { setScriptReportJobInspector, importScriptReports } = await import('../../../packages/server/src/modules/studio/public/script-reports')
const { readNativeJob } = await import('../../../packages/server/src/modules/hermes/services/script-reports/native-jobs')
setScriptReportJobInspector(readNativeJob)
;(globalThis as any).__importing = true
const result = importScriptReports()
console.log(`RESULT ${JSON.stringify({ processed: result.processed, accepted: result.accepted.length })}`)
