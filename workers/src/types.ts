// ── Cloudflare Worker environment bindings ────────────────────────────────────
export interface Env {
  // D1 database (configured in wrangler.toml)
  DB: D1Database;

  // Auth0 — set in [vars] in wrangler.toml
  AUTH0_DOMAIN: string;   // e.g. "your-tenant.us.auth0.com"
  AUTH0_AUDIENCE: string; // e.g. "https://council-api"

  // CORS allowed origin — your Dreamhost domain
  ALLOWED_ORIGIN: string; // e.g. "https://yoursite.com"

  // LLM API keys — set via `wrangler secret put`
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GOOGLE_API_KEY: string;
  XAI_API_KEY: string;
}

// ── LLM message format (mirrors Python Message dataclass) ────────────────────
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Model configuration ───────────────────────────────────────────────────────
export interface ModelConfig {
  name: string;
  provider: 'anthropic' | 'openai' | 'google' | 'xai';
  modelId: string;
  apiKey: string;
}

// ── Session deliberation state ────────────────────────────────────────────────
export interface Turn {
  modelName: string;
  role: string;
  content: string; // may contain [COUNCIL_DONE] for the first model's follow-up
}

// ── API request/response shapes ───────────────────────────────────────────────
export interface SessionRequest {
  query: string;
  rag_documents?: Array<{ filename: string; content: string }>;
  prior_conversation?: string;
  // Cumulative display history from previous sessions in this thread. The
  // worker treats it opaquely and prepends it to the new turns when saving,
  // so a saved follow-up session contains the full Q&A chain back to the
  // first question.
  prior_display_turns?: DisplayEntry[];
}

// ── Persisted user record (D1) ───────────────────────────────────────────────
export interface User {
  id: string;         // Auth0 sub
  email: string;
  name: string | null;
  picture: string | null;
  created_at: number; // Unix epoch seconds
  last_login: number;
}

// ── Display-friendly entries for client rehydration ──────────────────────────
// Stored as JSON in sessions.display_turns so the frontend can replay the full
// conversation (user questions + each council turn) when a user opens a session
// from history.
export interface DisplayTurn {
  kind: 'turn';
  model_key: string;  // lowercased model name, matches modelColorMap key
  name: string;       // e.g. "Claude"
  role: string;       // e.g. "Council Discussion", "Final Synthesis"
  content: string;    // raw markdown
  html: string;       // rendered HTML (server-side via marked)
}

export interface DisplayUserEntry {
  kind: 'user';
  query: string;
}

export type DisplayEntry = DisplayTurn | DisplayUserEntry;

// ── Persisted session record (D1) ────────────────────────────────────────────
export interface SessionRecord {
  id: string;
  user_id: string;
  title: string;              // query truncated to 120 chars
  query: string;              // full original query
  conversation_text: string;  // full prior-conversation text fed back to LLMs
  display_turns: string;      // JSON-encoded DisplayTurn[] for UI rehydration
  model_names: string;        // JSON-encoded string[], e.g. '["Claude","GPT"]'
  iterations: number;
  created_at: number;         // Unix epoch seconds
}

// Lightweight list view (heavy fields omitted for list responses)
export type SessionListItem = Omit<
  SessionRecord,
  'conversation_text' | 'query' | 'display_turns'
>;
