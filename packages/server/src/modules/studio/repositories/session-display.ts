import { MESSAGES_TABLE } from '../infrastructure/database/schemas'

/** Shared by list queries whose session table uses the alias s. */
export const SESSION_PREVIEW_SQL = `COALESCE(NULLIF(s.preview, ''),
  (SELECT SUBSTR(REPLACE(REPLACE(m.content, CHAR(10), ' '), CHAR(13), ' '), 1, 63)
   FROM ${MESSAGES_TABLE} m
   WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
   ORDER BY m.timestamp, m.id LIMIT 1), '')`

export function sessionDisplayTitle(title: string | null, preview: string): string | null {
  return title || (preview ? (preview.length > 40 ? `${preview.slice(0, 40)}...` : preview) : null)
}
