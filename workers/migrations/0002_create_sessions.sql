-- Persisted council sessions for conversation history and follow-ups.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT    PRIMARY KEY,           -- UUID
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT    NOT NULL,              -- query truncated to 120 chars (display)
  query             TEXT    NOT NULL,              -- full original user prompt
  conversation_text TEXT    NOT NULL,              -- full dialogue passed to LLMs as prior context
  model_names       TEXT    NOT NULL,              -- JSON array, e.g. '["Claude","GPT","Gemini","Grok"]'
  iterations        INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL               -- Unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_created
  ON sessions (user_id, created_at DESC);
