import { validateToken } from './auth.ts';
import { upsertUser } from './db.ts';
import { runSessionEvents } from './session.ts';
import type { Env, ModelConfig, SessionRequest } from './types.ts';

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ── Model config from env ─────────────────────────────────────────────────────

function buildModelConfigs(env: Env): ModelConfig[] {
  const configs: ModelConfig[] = [];

  if (env.ANTHROPIC_API_KEY) {
    configs.push({
      name: 'Claude',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      apiKey: env.ANTHROPIC_API_KEY,
    });
  }
  if (env.OPENAI_API_KEY) {
    configs.push({
      name: 'GPT',
      provider: 'openai',
      modelId: 'gpt-4o',
      apiKey: env.OPENAI_API_KEY,
    });
  }
  if (env.GOOGLE_API_KEY) {
    configs.push({
      name: 'Gemini',
      provider: 'google',
      modelId: 'gemini-2.5-flash',
      apiKey: env.GOOGLE_API_KEY,
    });
  }
  if (env.XAI_API_KEY) {
    configs.push({
      name: 'Grok',
      provider: 'xai',
      modelId: 'grok-3',
      apiKey: env.XAI_API_KEY,
    });
  }

  return configs;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleSession(request: Request, env: Env, origin: string): Promise<Response> {
  // Authenticate
  let auth;
  try {
    auth = await validateToken(request, env);
  } catch (err) {
    return jsonResponse({ error: 'Unauthorized', detail: String(err) }, 401, origin);
  }

  // Ensure user exists in D1
  await upsertUser(env, auth);

  const req = await request.json<SessionRequest>();
  if (!req.query?.trim()) {
    return jsonResponse({ error: 'query is required' }, 400, origin);
  }

  const models = buildModelConfigs(env);
  if (models.length < 2) {
    return jsonResponse(
      { error: 'At least 2 LLM API keys must be configured as Worker secrets.' },
      500,
      origin,
    );
  }

  // Stream SSE via TransformStream
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Run session asynchronously — do not await here so the Response can be
  // returned immediately and streaming can begin.
  (async () => {
    try {
      for await (const chunk of runSessionEvents(models, req)) {
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
      'X-Accel-Buffering': 'no', // disable nginx buffering if behind a proxy
      ...corsHeaders(origin),
    },
  });
}

async function handleUpload(request: Request, env: Env, origin: string): Promise<Response> {
  try {
    await validateToken(request, env);
  } catch (err) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }

  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  const documents = await Promise.all(
    files.map(async (file) => {
      const filename = file.name;
      try {
        // Workers don't have a PDF parser; text-based files are supported.
        // PDF support can be added with a WASM PDF library (e.g. unpdf).
        const text = await file.text();
        const MAX_CHARS = 80_000;
        const truncated = text.length > MAX_CHARS;
        return {
          filename,
          content: truncated ? text.slice(0, MAX_CHARS) : text,
          truncated,
          size: file.size,
        };
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
  } catch (err) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin);
  }

  const user = await upsertUser(env, auth);
  return jsonResponse(user, 200, origin);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const { method, pathname } = { method: request.method, pathname: url.pathname };

    if (method === 'POST' && pathname === '/api/session') {
      return handleSession(request, env, origin);
    }

    if (method === 'POST' && pathname === '/api/upload') {
      return handleUpload(request, env, origin);
    }

    if (method === 'GET' && pathname === '/api/user') {
      return handleUser(request, env, origin);
    }

    if (method === 'GET' && pathname === '/health') {
      return jsonResponse({ status: 'ok' }, 200, origin);
    }

    return jsonResponse({ error: 'Not Found' }, 404, origin);
  },
} satisfies ExportedHandler<Env>;
