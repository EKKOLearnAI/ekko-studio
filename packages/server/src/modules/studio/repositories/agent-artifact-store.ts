import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type ImageArtifact } from '../contracts/plugins'

/** Immutable image bytes share the application's SQLite backup boundary. */
export class AgentArtifactStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_agent_artifacts (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      media_type TEXT NOT NULL, byte_length INTEGER NOT NULL, data BLOB NOT NULL
    ); CREATE INDEX IF NOT EXISTS studio_agent_artifact_owner ON studio_agent_artifacts(owner_id, profile_id);`)
  }

  create(ownerId: string, profileId: string, mediaType: string, data: Buffer): ImageArtifact {
    this.db.exec('SAVEPOINT studio_agent_artifact_create')
    try {
      const totals = this.db.prepare(`SELECT count(*) AS count, coalesce(sum(byte_length),0) AS bytes,
        coalesce(sum(CASE WHEN owner_id=? THEN byte_length ELSE 0 END),0) AS owned,
        coalesce(sum(CASE WHEN owner_id=? THEN 1 ELSE 0 END),0) AS owned_count FROM studio_agent_artifacts`)
        .get(ownerId, ownerId) as { count: number; bytes: number; owned: number; owned_count: number }
      if (totals.count >= 4096 || totals.owned_count >= 256 || totals.bytes + data.length > 256 * 1024 * 1024
        || totals.owned + data.length > 64 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Image storage quota exceeded')
      const id = randomUUID()
      this.db.prepare('INSERT INTO studio_agent_artifacts VALUES (?, ?, ?, ?, ?, ?)').run(id, ownerId, profileId, mediaType, data.length, data)
      this.db.exec('RELEASE studio_agent_artifact_create')
      return { id, mediaType, byteLength: data.length }
    } catch (error) { this.db.exec('ROLLBACK TO studio_agent_artifact_create; RELEASE studio_agent_artifact_create'); throw error }
  }

  metadata(ownerId: string, profileId: string, id: string): ImageArtifact | null {
    const row = this.db.prepare('SELECT media_type AS mediaType, byte_length AS byteLength FROM studio_agent_artifacts WHERE id=? AND owner_id=? AND profile_id=?')
      .get(id, ownerId, profileId) as Omit<ImageArtifact, 'id'> | undefined
    return row ? { id, ...row } : null
  }

  chunk(id: string, offset: number, length: number): Buffer {
    const row = this.db.prepare('SELECT substr(data, ?, ?) AS chunk FROM studio_agent_artifacts WHERE id=?').get(offset + 1, length, id) as { chunk: Uint8Array }
    return Buffer.from(row.chunk)
  }

  removeUnused(id: string): void {
    const used = this.db.prepare(`SELECT 1 FROM studio_agent_run_admissions, json_each(effective_input_json, '$.content') AS block
      WHERE json_extract(block.value, '$.artifactId')=?
      UNION ALL SELECT 1 FROM studio_agent_run_admissions, json_each(original_input_json, '$.content') AS block
      WHERE json_extract(block.value, '$.artifactId')=? LIMIT 1`).get(id, id)
    if (used) throw new StudioError('REVISION_CONFLICT', 'Images attached to accepted Runs are retained with history')
    this.db.prepare('DELETE FROM studio_agent_artifacts WHERE id=?').run(id)
  }
}
