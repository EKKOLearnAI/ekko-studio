import type { EkkoDatabaseMigration } from '../database'

export const EKKO_SESSIONS_TABLE = 'sessions'
export const EKKO_MESSAGES_TABLE = 'messages'

export const EKKO_CONVERSATION_MIGRATIONS: EkkoDatabaseMigration[] = [
  {
    component: 'conversations',
    version: 1,
    migrate(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ${EKKO_SESSIONS_TABLE} (
          id TEXT PRIMARY KEY,
          profile TEXT NOT NULL DEFAULT 'default',
          source TEXT NOT NULL DEFAULT 'ekko-agent',
          agent TEXT NOT NULL DEFAULT 'ekko-agent',
          agent_mode TEXT NOT NULL DEFAULT '',
          agent_session_id TEXT NOT NULL DEFAULT '',
          agent_native_session_id TEXT NOT NULL DEFAULT '',
          user_id TEXT,
          model TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          api_mode TEXT NOT NULL DEFAULT '',
          title TEXT,
          parent_session_id TEXT,
          fork_point_message_id TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          end_reason TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          billing_provider TEXT,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          actual_cost_usd REAL,
          cost_status TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          last_active INTEGER NOT NULL,
          is_archived INTEGER NOT NULL DEFAULT 0,
          workspace TEXT,
          category_id INTEGER,
          history_revision INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ${EKKO_MESSAGES_TABLE} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          display_role TEXT,
          display_content TEXT,
          tool_call_id TEXT,
          tool_calls TEXT,
          tool_name TEXT,
          timestamp INTEGER NOT NULL,
          token_count INTEGER,
          finish_reason TEXT,
          reasoning TEXT,
          reasoning_details TEXT,
          reasoning_content TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_profile_last_active
          ON ${EKKO_SESSIONS_TABLE}(profile, last_active DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_source_last_active
          ON ${EKKO_SESSIONS_TABLE}(source, last_active DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent
          ON ${EKKO_SESSIONS_TABLE}(parent_session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_session_id
          ON ${EKKO_MESSAGES_TABLE}(session_id, id);
        CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
          ON ${EKKO_MESSAGES_TABLE}(session_id, timestamp, id);
      `)
    },
  },
  {
    component: 'conversations',
    version: 2,
    migrate(database) {
      // NULL marks older histories whose derived preview and counters need one refresh.
      database.exec('ALTER TABLE ' + EKKO_SESSIONS_TABLE + ' ADD COLUMN message_preview TEXT')
    },
  },
]
