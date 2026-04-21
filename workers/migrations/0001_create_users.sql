-- Council of AIs — D1 schema
-- Stores users authenticated via Auth0.

CREATE TABLE IF NOT EXISTS users (
  -- Auth0 subject identifier, e.g. "auth0|65abc123..."
  id          TEXT    PRIMARY KEY,
  email       TEXT    NOT NULL,
  name        TEXT,
  picture     TEXT,
  created_at  INTEGER NOT NULL,  -- Unix epoch seconds
  last_login  INTEGER NOT NULL   -- Unix epoch seconds
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);
