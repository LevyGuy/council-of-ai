import { marked } from 'marked';
import { streamAnthropic } from './providers/anthropic.ts';
import { streamOpenAI } from './providers/openai.ts';
import { streamGoogle } from './providers/google.ts';
import type { Message, ModelConfig, SessionRequest, Turn } from './types.ts';

// ── Constants (mirrors Python session.py) ────────────────────────────────────
const COMPLETE_SIGNAL = '[COUNCIL_DONE]';
const MAX_ITERATIONS = 4;

const ROUND_TABLE_PREAMBLE =
  'You are participating in a formal round table discussion with other AI models. ' +
  'Maintain a professional, academic tone throughout — as if you are panelists ' +
  'at a professional conference or peer reviewers in a journal. ' +
  'Address other participants by name directly (e.g., \'GPT, your point about X is well-taken\' ' +
  'or \'I would note that Gemini\'s analysis overlooks...\'). ' +
  'Do NOT use casual greetings like \'Hey\', \'Hey everyone\', \'Great discussion\', or similar. ' +
  'Do NOT narrate in third person (don\'t say \'Claude provides...\' — say \'Claude, you provide...\'). ' +
  'Get straight to the substance.\n\n';

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildInitialSystemPrompt(modelName: string, isFollowup: boolean): string {
  if (isFollowup) {
    return (
      `Your name is ${modelName}. The user has asked a follow-up question ` +
      `to a previous council discussion. The full prior conversation is provided for context. ` +
      `You are the first to respond to this follow-up — no one else has spoken yet on this new question. ` +
      `Answer the user's follow-up question directly, building on the prior discussion. ` +
      `Do NOT reference or address other models, as they have not said anything yet on this follow-up. ` +
      `Give a thorough but concise answer.`
    );
  }
  return (
    `Your name is ${modelName}. A user has posed a question. ` +
    `You are the first to respond — no one else has spoken yet. ` +
    `Answer the user's question directly. Do NOT reference or address other models, ` +
    `as they have not said anything yet. Give a thorough but concise answer.`
  );
}

function buildReviewSystemPrompt(currentModel: string, modelsWhoSpoke: string[]): string {
  const spokeStr = modelsWhoSpoke.join(', ');
  return (
    ROUND_TABLE_PREAMBLE +
    `Your name is ${currentModel}. ` +
    `You are sitting at a round table discussion. ` +
    `The user asked a question and so far the following participants have responded: ${spokeStr}. ` +
    `ONLY review and reference models whose responses actually appear above. ` +
    `Do NOT reference or address any model that has not spoken yet. ` +
    `Review ALL of the responses above — not just the last one. ` +
    `For each response you find noteworthy:\n` +
    `a. Grade its accuracy.\n` +
    `b. Offer adjustments or push back if you disagree.\n` +
    `c. Highlight points you agree with.\n` +
    `Address each participant by name directly. ` +
    `Keep your response short and concise.`
  );
}

function buildFollowupSystemPrompt(firstModel: string): string {
  return (
    ROUND_TABLE_PREAMBLE +
    `Your name is ${firstModel}. You gave the initial response and the rest of the table ` +
    `has weighed in with their reviews and feedback.\n\n` +
    `If you believe the discussion has reached a solid conclusion, provide a brief summary that includes:\n` +
    `- What the user originally asked\n` +
    `- The key points and consensus from the discussion\n` +
    `- Any remaining nuances or caveats\n` +
    `End your summary with the marker: ${COMPLETE_SIGNAL}\n\n` +
    `If you think there are still meaningful points to address or corrections to make, ` +
    `share them and do NOT include ${COMPLETE_SIGNAL}. ` +
    `Keep your response short and concise.`
  );
}

function buildUserMessage(userPrompt: string, ragContext = ''): string {
  return ragContext ? `${ragContext}\n\nUser question: ${userPrompt}` : userPrompt;
}

function buildRagContext(ragDocs: Array<{ filename: string; content: string }>): string {
  if (!ragDocs.length) return '';
  const sections = ragDocs.map(
    (d) => `=== ${d.filename} ===\n${d.content}`,
  );
  return `=== Attached Reference Documents ===\n\n${sections.join('\n\n')}`;
}

function buildConversationText(
  userPrompt: string,
  turns: Turn[],
  ragContext = '',
  priorConversation = '',
): string {
  const parts: string[] = [];
  if (priorConversation) {
    parts.push(priorConversation);
    parts.push(`User (follow-up): ${buildUserMessage(userPrompt, ragContext)}`);
  } else {
    parts.push(`User: ${buildUserMessage(userPrompt, ragContext)}`);
  }
  for (const turn of turns) {
    parts.push(`${turn.modelName}: ${turn.content}`);
  }
  return parts.join('\n\n');
}

// ── Markdown → HTML ───────────────────────────────────────────────────────────

async function markdownToHtml(md: string): Promise<string> {
  return await marked(md, { gfm: true, breaks: true }) as string;
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

async function* streamModel(
  config: ModelConfig,
  messages: Message[],
): AsyncGenerator<string> {
  switch (config.provider) {
    case 'anthropic':
      yield* streamAnthropic(config.apiKey, config.modelId, messages);
      break;
    case 'openai':
      yield* streamOpenAI(config.apiKey, config.modelId, messages);
      break;
    case 'google':
      yield* streamGoogle(config.apiKey, config.modelId, messages);
      break;
    case 'xai':
      yield* streamOpenAI(config.apiKey, config.modelId, messages, 'https://api.x.ai/v1');
      break;
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── Core deliberation loop ────────────────────────────────────────────────────

/**
 * Runs the full council deliberation and yields raw SSE-formatted strings.
 * This is an async generator so it can be piped directly into a
 * TransformStream for streaming HTTP responses.
 *
 * The event protocol mirrors the Python server.py implementation exactly so
 * the existing frontend JavaScript requires no changes beyond the API URL and
 * auth header.
 */
export async function* runSessionEvents(
  models: ModelConfig[],
  req: SessionRequest,
  maxIterations = MAX_ITERATIONS,
): AsyncGenerator<string> {
  const isFollowup = Boolean(req.prior_conversation);
  const ragContext = buildRagContext(req.rag_documents ?? []);

  // Shuffle the panel order
  const shuffled = [...models].sort(() => Math.random() - 0.5);
  const first = shuffled[0];
  const reviewers = shuffled.slice(1);

  yield sse({
    type: 'session_start',
    models: shuffled.map((m) => ({ name: m.name, key: m.name.toLowerCase() })),
  });

  const allTurns: Turn[] = [];

  for (let iterNum = 1; iterNum <= maxIterations; iterNum++) {
    yield sse({ type: 'iteration', number: iterNum, max: maxIterations });

    // ── Iteration 1: first model gives initial response ──────────────────────
    if (iterNum === 1) {
      const systemPrompt = buildInitialSystemPrompt(first.name, isFollowup);
      const userContent = isFollowup
        ? buildConversationText(req.query, [], ragContext, req.prior_conversation)
        : buildUserMessage(req.query, ragContext);

      const messages: Message[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];

      yield sse({
        type: 'speaker',
        model_key: first.name.toLowerCase(),
        name: first.name,
        role: 'Initial Response',
      });

      let fullText = '';
      try {
        for await (const chunk of streamModel(first, messages)) {
          fullText += chunk;
          yield sse({ type: 'chunk', text: chunk });
        }
      } catch (err) {
        yield sse({ type: 'error', model: first.name, message: String(err) });
        break;
      }

      const cleanText = fullText.replace(COMPLETE_SIGNAL, '').trim();
      yield sse({
        type: 'turn_end',
        content: cleanText,
        html: await markdownToHtml(cleanText),
      });
      allTurns.push({ modelName: first.name, role: 'Initial Response', content: fullText });
    }

    // ── Reviewers ─────────────────────────────────────────────────────────────
    for (const reviewer of reviewers) {
      const modelsWhoSpoke = [...new Set(allTurns.map((t) => t.modelName))];
      const conversationText = buildConversationText(
        req.query, allTurns, ragContext, req.prior_conversation,
      );

      const messages: Message[] = [
        { role: 'system', content: buildReviewSystemPrompt(reviewer.name, modelsWhoSpoke) },
        { role: 'user', content: conversationText },
      ];

      yield sse({
        type: 'speaker',
        model_key: reviewer.name.toLowerCase(),
        name: reviewer.name,
        role: 'Review',
      });

      let fullText = '';
      try {
        for await (const chunk of streamModel(reviewer, messages)) {
          fullText += chunk;
          yield sse({ type: 'chunk', text: chunk });
        }
      } catch (err) {
        yield sse({ type: 'error', model: reviewer.name, message: String(err) });
        continue; // skip this reviewer, continue with others
      }

      const cleanText = fullText.replace(COMPLETE_SIGNAL, '').trim();
      yield sse({
        type: 'turn_end',
        content: cleanText,
        html: await markdownToHtml(cleanText),
      });
      allTurns.push({ modelName: reviewer.name, role: 'Review', content: fullText });
    }

    // ── First model follow-up / completion check ──────────────────────────────
    const conversationText = buildConversationText(
      req.query, allTurns, ragContext, req.prior_conversation,
    );

    const messages: Message[] = [
      { role: 'system', content: buildFollowupSystemPrompt(first.name) },
      { role: 'user', content: conversationText },
    ];

    yield sse({
      type: 'speaker',
      model_key: first.name.toLowerCase(),
      name: first.name,
      role: 'Follow-up',
    });

    let fullText = '';
    try {
      for await (const chunk of streamModel(first, messages)) {
        fullText += chunk;
        yield sse({ type: 'chunk', text: chunk });
      }
    } catch (err) {
      yield sse({ type: 'error', model: first.name, message: String(err) });
      break;
    }

    const cleanText = fullText.replace(COMPLETE_SIGNAL, '').trim();
    yield sse({
      type: 'turn_end',
      content: cleanText,
      html: await markdownToHtml(cleanText),
    });
    allTurns.push({ modelName: first.name, role: 'Follow-up', content: cleanText });

    if (fullText.includes(COMPLETE_SIGNAL)) break;
  }

  const iterations = allTurns.filter((t) => t.role === 'Follow-up').length;
  const conversationText = buildConversationText(
    req.query, allTurns, ragContext, req.prior_conversation,
  );

  yield sse({
    type: 'done',
    iterations,
    transcript: null, // Workers don't persist files; history lives client-side
    conversation_text: conversationText,
  });
}
