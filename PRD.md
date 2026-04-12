# Council of AI — Product Requirements Document

## 1. Overview

**Council of AI** is a CLI application that orchestrates a multi-LLM deliberation session. The user poses a question or prompt, and a panel of LLM models take turns responding, reviewing each other's answers, grading accuracy, and suggesting adjustments. The process repeats until consensus is reached or a hard iteration limit is hit.

The goal is to produce higher-quality, peer-reviewed AI responses by leveraging the strengths and perspectives of multiple models.

---

## 2. Participants

Each session has the following participants:

| Role | Description |
|------|-------------|
| **User** | A human who initiates the session with a prompt and reads the final output. |
| **LLM Panel** | A configurable set of LLM APIs (default: Claude, Grok, GPT, Gemini). Each model is identified by a display name. |

---

## 3. Session Lifecycle

### 3.1 Initialization

1. Load configuration (models, API keys, iteration limits).
2. Randomly shuffle the model order for this session. This order is fixed for the entire session.
3. Display the shuffled order to the user (e.g., "Panel order: Grok, Gemini, Claude, GPT").

### 3.2 Round 1 — Initial Response

1. The user enters a prompt.
2. The **first model** in the queue receives the user's prompt and generates an initial response.
3. The initial response is displayed to the user.

### 3.3 Round 1 — Peer Review Chain

4. The **second model** receives the full context (user prompt + first model's response) along with a system instruction:

   ```
   Your name is {current_model}.
   The above is the user's prompt followed by {previous_model}'s response.
   Please review {previous_model}'s response and:
   a. Grade its accuracy.
   b. Offer adjustments if any.
   In your response, refer to {previous_model} by name.
   Keep your responses short and concise.
   ```

5. This continues for each subsequent model in the queue. Each model sees the **full conversation history** up to that point (user prompt, all prior model responses and reviews).

6. Once all models have responded, the **first model** (the original responder) is asked:

   ```
   Your name is {first_model}.
   The above is the full conversation so far. The other models have reviewed your response.
   Do you have anything to add, correct, or adjust based on their feedback?
   If the conversation is complete and no changes are needed, respond with exactly: [COMPLETE]
   Otherwise, provide your additions or corrections. Keep your response short and concise.
   ```

### 3.4 Subsequent Iterations

7. **If the first model responds with `[COMPLETE]`** — the session ends.
8. **If the first model has additions** — a new iteration begins. The queue loops again in the same order (starting from the second model reviewing the first model's additions, then third, etc.), followed by another check-in with the first model.
9. **Hard stop**: The session ends after a maximum of **4 total iterations** of the queue, regardless of whether consensus is reached.

### 3.5 Session End

10. Display a summary separator in the CLI.
11. Save the full transcript to disk (see Section 7).
12. Return the user to the prompt for a new session or exit.

---

## 4. Configuration

The application uses a configuration file (`config.yaml`) with CLI argument overrides.

### 4.1 Model Configuration

```yaml
models:
  - name: Claude
    provider: anthropic
    model_id: claude-sonnet-4-20250514
    api_key_env: ANTHROPIC_API_KEY

  - name: GPT
    provider: openai
    model_id: gpt-4o
    api_key_env: OPENAI_API_KEY

  - name: Gemini
    provider: google
    model_id: gemini-2.5-flash
    api_key_env: GOOGLE_API_KEY

  - name: Grok
    provider: xai
    model_id: grok-3
    api_key_env: XAI_API_KEY
```

### 4.2 Session Configuration

```yaml
session:
  max_iterations: 4          # Hard stop for queue loops
  transcript_dir: ./transcripts  # Where to save session transcripts
  shuffle: true              # Randomly shuffle model order each session
```

### 4.3 CLI Arguments (Override Config)

| Flag | Description | Default |
|------|-------------|---------|
| `--config` | Path to config file | `./config.yaml` |
| `--max-iterations` | Override max iteration count | 4 |
| `--no-shuffle` | Disable random shuffling (use config order) | false |
| `--models` | Comma-separated list of model names to include (subset) | all |

---

## 5. LLM Provider Interface

Each provider must implement a common interface:

```
send_message(messages: list[Message]) -> str
```

Where `Message` has:
- `role`: `"system"`, `"user"`, or `"assistant"`
- `content`: the text content
- `name`: display name of the model (for context)

Supported providers:
- **Anthropic** (Claude) — via `anthropic` SDK
- **OpenAI** (GPT) — via `openai` SDK
- **Google** (Gemini) — via `google-genai` SDK
- **xAI** (Grok) — via `openai`-compatible SDK (xAI uses OpenAI-compatible API)

---

## 6. CLI Display

The CLI should provide clear, readable output with visual separation between models.

```
============================================
  Council of AI — New Session
  Panel order: Grok, Gemini, Claude, GPT
============================================

You: What causes inflation?

--- Grok (Initial Response) ---
[Grok's response]

--- Gemini (Review #1) ---
[Gemini's review of Grok]

--- Claude (Review #2) ---
[Claude's review, referencing Grok and Gemini]

--- GPT (Review #3) ---
[GPT's review, referencing all previous]

--- Grok (Follow-up) ---
[COMPLETE]

============================================
  Session complete after 1 iteration.
  Transcript saved to: ./transcripts/2026-04-12_18-30-00.md
============================================
```

Requirements:
- Each model's output is prefixed with its name and role (Initial Response, Review, Follow-up).
- Responses stream to the terminal as they arrive (streaming support).
- Iteration count is displayed at the end.
- Use color coding per model (optional enhancement).

---

## 7. Transcript Persistence

After each session, save the full transcript as a Markdown file.

### File naming
```
{transcript_dir}/{YYYY-MM-DD}_{HH-MM-SS}.md
```

### File structure
```markdown
# Council of AI — Session Transcript
- **Date**: 2026-04-12 18:30:00
- **Panel order**: Grok, Gemini, Claude, GPT
- **Iterations**: 1
- **User prompt**: What causes inflation?

## Iteration 1

### Grok (Initial Response)
[response]

### Gemini (Review)
[response]

### Claude (Review)
[response]

### GPT (Review)
[response]

### Grok (Follow-up)
[COMPLETE]
```

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| API key missing | Print error for that model, skip it, continue with remaining models. Require minimum 2 models. |
| API call fails (timeout, rate limit, server error) | Retry up to 2 times with exponential backoff. If still failing, skip that model for the current turn and note it in the transcript. |
| Model returns empty response | Treat as a skip, note in transcript, continue. |
| All models fail | End session, display error, save partial transcript. |
| User interrupts (Ctrl+C) | Gracefully save partial transcript and exit. |

---

## 9. Project Structure

```
council-of-ai/
  config.yaml              # Default configuration
  requirements.txt         # Python dependencies
  README.md                # Setup and usage instructions
  council/
    __init__.py
    main.py                # CLI entry point, session orchestration
    config.py              # Config loading and validation
    models.py              # Model queue, shuffling, iteration logic
    providers/
      __init__.py
      base.py              # Abstract provider interface
      anthropic.py         # Claude provider
      openai_provider.py   # GPT provider
      google.py            # Gemini provider
      xai.py               # Grok provider (OpenAI-compatible)
    session.py             # Session state, conversation history management
    transcript.py          # Transcript saving
    display.py             # CLI formatting and output
  transcripts/             # Saved session transcripts
```

---

## 10. Dependencies

- `anthropic` — Claude API
- `openai` — GPT and Grok (xAI) APIs
- `google-genai` — Gemini API
- `pyyaml` — Config file parsing
- `rich` — CLI formatting, colors, and streaming display

---

## 11. Out of Scope (v1)

- Web UI
- Multi-turn user follow-ups within a session (user speaks once, then the council deliberates)
- Parallel API calls (models are called sequentially by design)
- Cost tracking / token counting
- Model temperature or parameter tuning per-model in config

---

## 12. Success Criteria

1. User can start a session, enter a prompt, and see all models respond in sequence.
2. Models correctly reference each other by name in reviews.
3. The first model's `[COMPLETE]` signal terminates the loop.
4. The hard stop at 4 iterations is enforced.
5. Transcripts are saved correctly after each session.
6. Graceful handling of API failures without crashing.
