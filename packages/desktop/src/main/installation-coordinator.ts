import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}
/** SQLite owns the short transaction lock; killed processes cannot strand it. */
export class InstallationCoordinator {
  private readonly db: DatabaseSync
  private installing = false
  constructor(executable: string, root = join(homedir(), '.ekko-desktop-installations')) {
    const canonical = realpathSync(executable)
    const directory = join(root, createHash('sha256').update(canonical).digest('hex'))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(directory, 'coordination.sqlite'))
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS members(pid INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS installation(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, version TEXT NOT NULL);')
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private members(): number[] {
    return this.db.prepare('SELECT pid FROM members').all().flatMap(row => {
      const pid = Number(row.pid)
      if (alive(pid)) return [pid]
      this.db.prepare('DELETE FROM members WHERE pid=?').run(pid); return []
    })
  }
  register(installedVersion: string): void {
    this.transaction(() => {
      const record = this.db.prepare('SELECT pid,version FROM installation WHERE id=1').get()
      if (record) {
        if (record.version === installedVersion && !alive(Number(record.pid))) this.db.exec('DELETE FROM installation')
        else throw new Error('DESKTOP_INSTALLATION_IN_PROGRESS')
      }
      this.members()
      this.db.prepare('INSERT OR IGNORE INTO members VALUES(?)').run(process.pid)
    })
  }
  /** Only call following explicit user confirmation; never time out an installer. */
  recoverInterruptedInstall(): void {
    this.transaction(() => {
      const record = this.db.prepare('SELECT pid FROM installation WHERE id=1').get()
      if (record && alive(Number(record.pid))) throw new Error('DESKTOP_INSTALLATION_IN_PROGRESS')
      this.db.exec('DELETE FROM installation')
    })
  }
  beginInstall(targetVersion: string): () => void {
    this.transaction(() => {
      if (this.members().some(pid => pid !== process.pid)) throw new Error('DESKTOP_OTHER_DEVICE_WINDOWS_OPEN')
      this.db.prepare('INSERT INTO installation VALUES(1,?,?)').run(process.pid, targetVersion)
      this.installing = true
    })
    return () => this.transaction(() => {
      if (this.installing) { this.db.exec('DELETE FROM installation'); this.installing = false }
    })
  }
  close(): void { this.db.close() }
  release(): void {
    this.db.prepare('DELETE FROM members WHERE pid=?').run(process.pid)
    this.db.close()
  }
}
