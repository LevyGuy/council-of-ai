import type { Env, User } from './types.ts';
import type { AuthPayload } from './auth.ts';

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

  // First-time login — create the record
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
