-- Persist a structured, display-friendly view of each session so the frontend
-- can rehydrate the full conversation (model name + role + rendered HTML for
-- each turn) when the user opens it from history.  The legacy conversation_text
-- column remains the source of truth for feeding follow-ups back to the LLMs.

ALTER TABLE sessions ADD COLUMN display_turns TEXT NOT NULL DEFAULT '[]';
