import type { Env, SessionListItem, SessionRecord, User } from './types.ts';
import type { AuthPayload } from './auth.ts';

// ── Users ─────────────────────────────────────────────────────────────────────

/**
 * Inserts a new user or updates last_login / profile fields if they already
 * exist.  Returns the current (updated) user record.
 */
export async function upsertUser(env: Env, auth: AuthPayload): Promise<User> {
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(auth.sub)
    .first<User>();

  if (existing) {
    await env.DB
      .prepare(
        'UPDATE users SET last_login = ?, name = ?, picture = ? WHERE id = ?',
      )
      .bind(now, auth.name ?? null, auth.picture ?? null, auth.sub)
      .run();

    return { ...existing, last_login: now, name: auth.name ?? existing.name, picture: auth.picture ?? existing.picture };
  }

  const email = auth.email ?? '';
  await env.DB
    .prepare(
      `INSERT INTO users (id, email, name, picture, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(auth.sub, email, auth.name ?? null, auth.picture ?? null, now, now)
    .run();

  return {
    id: auth.sub,
    email,
    name: auth.name ?? null,
    picture: auth.picture ?? null,
    created_at: now,
    last_login: now,
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────

interface SaveSessionInput {
  id: string;
  query: string;
  conversation_text: string;
  model_names: string; // JSON-encoded string[]
  iterations: number;
}

/** Persist a completed council session for the given user. */
export async function saveSession(
  env: Env,
  userId: string,
  data: SaveSessionInput,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const title = data.query.slice(0, 120);

  await env.DB
    .prepare(
      `INSERT INTO sessions (id, user_id, title, query, conversation_text, model_names, iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      data.id,
      userId,
      title,
      data.query,
      data.conversation_text,
      data.model_names,
      data.iterations,
      now,
    )
    .run();
}

/**
 * Returns up to 50 most-recent sessions for the user, without the heavy
 * conversation_text and full query fields (for list rendering).
 */
export async function listSessions(
  env: Env,
  userId: string,
): Promise<SessionListItem[]> {
  const { results } = await env.DB
    .prepare(
      `SELECT id, user_id, title, model_names, iterations, created_at
       FROM sessions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .bind(userId)
    .all<SessionListItem>();

  return results;
}

/**
 * Returns the full session record (including conversation_text) so the
 * frontend can resume a prior conversation.  Returns null if not found or
 * the session belongs to a different user.
 */
export async function getSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  return env.DB
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
    .first<SessionRecord>();
}

/** Hard-deletes a session.  No-ops silently if not found or wrong user. */
export async function deleteSession(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  await env.DB
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
    .run();
}
