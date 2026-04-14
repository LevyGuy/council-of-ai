import { validateToken } from './auth.ts';
import { deleteSession, getSession, listSessions, saveSession, upsertUser } from './db.ts';
import { runSessionEvents } from './session.ts';
import type { Env, ModelConfig, SessionRequest } from './types.ts';

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Model config from env ─────────────────────────────────────────────────────

function buildModelConfigs(env: Env): ModelConfig[] {
  const configs: ModelConfig[] = [];

  if (env.ANTHROPIC_API_KEY) {
    configs.push({ name: 'Claude', provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', apiKey: env.ANTHROPIC_API_KEY });
  }
  if (env.OPENAI_API_KEY) {
    configs.push({ name: 'GPT', provider: 'openai', modelId: 'gpt-4o', apiKey: env.OPENAI_API_KEY });
  }
  if (env.GOOGLE_API_KEY) {
    configs.push({ name: 'Gemini', provider: 'google', modelId: 'gemini-2.5-flash', apiKey: env.GOOGLE_API_KEY });
  }
  if (env.XAI_API_KEY) {
    configs.push({ name: 'Grok', provider: 'xai', modelId: 'grok-3', apiKey: env.XAI_API_KEY });
  }

  return configs;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleSession(request: Request, env: Env, origin: string): Promise<Response> {
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch (err) {
    return jsonResponse({ error: 'Unauthorized', detail: String(err) }, 401, origin);
  }

  await upsertUser(env, auth);

  const req = await request.json<SessionRequest>();
  if (!req.query?.trim()) {
    return jsonResponse({ error: 'query is required' }, 400, origin);
  }

  const models = buildModelConfigs(env);
  if (models.length < 2) {
    return jsonResponse({ error: 'At least 2 LLM API keys must be configured as Worker secrets.' }, 500, origin);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const userId = auth.sub;

  (async () => {
    let capturedModelNames: string[] = [];

    try {
      for await (const chunk of runSessionEvents(models, req)) {
        // Intercept events to capture metadata and save the session when done.
        if (chunk.startsWith('data: ')) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(chunk.slice(6).trimEnd());
          } catch {
            // Malformed chunk — pass through as-is
            await writer.write(encoder.encode(chunk));
            continue;
          }

          if (event.type === 'session_start') {
            capturedModelNames = (event.models as Array<{ name: string }>).map((m) => m.name);
          }

          if (event.type === 'done' && event.conversation_text) {
            // Persist the session and inject the generated ID into the done event
            const sessionId = crypto.randomUUID();
            try {
              await saveSession(env, userId, {
                id: sessionId,
                query: req.query,
                conversation_text: event.conversation_text as string,
                model_names: JSON.stringify(capturedModelNames),
                iterations: (event.iterations as number) ?? 1,
              });
              event.session_id = sessionId;
            } catch (dbErr) {
              // Non-fatal — the session still completes; history just won't be saved
              console.error('Failed to save session to D1:', dbErr);
            }

            await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            continue; // skip writing the unmodified original chunk
          }
        }

        await writer.write(encoder.encode(chunk));
      }
    } catch (err) {
      const errorEvent = `data: ${JSON.stringify({ type: 'error', model: 'system', message: String(err) })}\n\n`;
      await writer.write(encoder.encode(errorEvent));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(origin),
    },
  });
}

async function handleUpload(request: Request, env: Env, origin: string): Promise<Response> {
  try {
    await validateToken(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }

  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  const documents = await Promise.all(
    files.map(async (file) => {
      const filename = file.name;
      try {
        const text = await file.text();
        const MAX_CHARS = 80_000;
        const truncated = text.length > MAX_CHARS;
        return { filename, content: truncated ? text.slice(0, MAX_CHARS) : text, truncated, size: file.size };
      } catch (err) {
        return { filename, content: '', truncated: false, size: file.size, error: String(err) };
      }
    }),
  );

  return jsonResponse({ documents }, 200, origin);
}

async function handleUser(request: Request, env: Env, origin: string): Promise<Response> {
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }
  return jsonResponse(await upsertUser(env, auth), 200, origin);
}

// ── Session history routes ─────────────────────────────────────────────────────

async function handleListSessions(request: Request, env: Env, origin: string): Promise<Response> {
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }
  return jsonResponse(await listSessions(env, auth.sub), 200, origin);
}

async function handleGetSession(
  request: Request,
  env: Env,
  origin: string,
  sessionId: string,
): Promise<Response> {
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }

  const session = await getSession(env, auth.sub, sessionId);
  if (!session) return jsonResponse({ error: 'Not Found' }, 404, origin);
  return jsonResponse(session, 200, origin);
}

async function handleDeleteSession(
  request: Request,
  env: Env,
  origin: string,
  sessionId: string,
): Promise<Response> {
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }
  await deleteSession(env, auth.sub, sessionId);
  return jsonResponse({ ok: true }, 200, origin);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';
    const { method } = request;
    const { pathname } = url;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (method === 'POST' && pathname === '/api/session') {
      return handleSession(request, env, origin);
    }
    if (method === 'POST' && pathname === '/api/upload') {
      return handleUpload(request, env, origin);
    }
    if (method === 'GET' && pathname === '/api/user') {
      return handleUser(request, env, origin);
    }

    // Session history
    if (method === 'GET' && pathname === '/api/sessions') {
      return handleListSessions(request, env, origin);
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (method === 'GET')    return handleGetSession(request, env, origin, sessionId);
      if (method === 'DELETE') return handleDeleteSession(request, env, origin, sessionId);
    }

    if (method === 'GET' && pathname === '/health') {
      return jsonResponse({ status: 'ok' }, 200, origin);
    }

    return jsonResponse({ error: 'Not Found' }, 404, origin);
  },
} satisfies ExportedHandler<Env>;
