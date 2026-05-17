import { marked } from 'marked';
import { streamAnthropic } from './providers/anthropic.ts';
import { streamOpenAI } from './providers/openai.ts';
import { streamGoogle } from './providers/google.ts';
import type { DisplayEntry, DisplayTurn, Message, ModelConfig, SessionRequest, Turn } from './types.ts';

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

function buildIndependentSystemPrompt(modelName: string, isFollowup: boolean): string {
  let prompt =
    `Your name is ${modelName}. You are preparing for a multi-model council. ` +
    `Write your best independent answer before seeing any other model's response. ` +
    `Do not mention the council process or other models. ` +
    `Prioritize accuracy, useful nuance, and a clear answer to the user.`;
  if (isFollowup) {
    prompt += ` The user is asking a follow-up question; use the provided prior conversation only as context.`;
  }
  return prompt;
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

function buildAnonymousReviewSystemPrompt(currentModel: string): string {
  return (
    `Your name is ${currentModel}. You are privately reviewing anonymized answers ` +
    `from a multi-model council. Do not guess which model wrote which response. ` +
    `Evaluate only the content.\n\n` +
    `For each response, briefly assess accuracy, insight, omissions, and useful points. ` +
    `Then provide a final ranking from best to worst.\n\n` +
    `Your final ranking MUST use this exact format:\n` +
    `FINAL RANKING:\n` +
    `1. Response A\n` +
    `2. Response B\n` +
    `Only use the response labels provided in the prompt.`
  );
}

function buildDiscussionSystemPrompt(modelName: string): string {
  return (
    ROUND_TABLE_PREAMBLE +
    `Your name is ${modelName}. The council has already completed private independent ` +
    `answers and anonymous peer review. You are now in the visible named council discussion. ` +
    `Use the preparation brief to discuss the strongest points, disagreements, and minority views. ` +
    `Be candid but concise. Address other participants by name when responding to their points. ` +
    `Do not claim that the private review removed all bias; treat it as useful evidence.`
  );
}

function buildChairSystemPrompt(chairName: string): string {
  return (
    ROUND_TABLE_PREAMBLE +
    `Your name is ${chairName}. You are chairing the council after private independent ` +
    `answers, anonymous peer review, and a named discussion. Produce the final answer for the user. ` +
    `Include the practical consensus, important caveats, and a short minority report if a plausible ` +
    `lower-ranked view should not be ignored. Do not include process markers.`
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

function buildAnonymousReviewPrompt(
  userPrompt: string,
  labeledAnswers: Array<[string, Turn]>,
): string {
  const responsesText = labeledAnswers
    .map(([label, turn]) => `${label}:\n${turn.content}`)
    .join('\n\n');
  return (
    `The user asked:\n${userPrompt}\n\n` +
    `Here are independent answers from different models. They have been anonymized:\n\n` +
    `${responsesText}\n\n` +
    `Evaluate the responses and rank them from best to worst.`
  );
}

function parseRanking(text: string): string[] {
  const rankingText = text.includes('FINAL RANKING:')
    ? text.split('FINAL RANKING:').slice(1).join('FINAL RANKING:')
    : text;
  const matches = rankingText.match(/Response [A-Z]/g) ?? [];
  return [...new Set(matches)];
}

function aggregateRankings(
  reviewTurns: Turn[],
  reviewerLabelMaps: Record<string, Record<string, string>>,
): Array<{ model: string; average_rank: number; rankings_count: number; first_place_votes: number }> {
  const positions: Record<string, number[]> = {};
  const firstPlace: Record<string, number> = {};

  for (const turn of reviewTurns) {
    const labelMap = reviewerLabelMaps[turn.modelName] ?? {};
    parseRanking(turn.content).forEach((label, index) => {
      const modelName = labelMap[label];
      if (!modelName) return;
      if (!positions[modelName]) positions[modelName] = [];
      positions[modelName].push(index + 1);
      if (index === 0) firstPlace[modelName] = (firstPlace[modelName] ?? 0) + 1;
    });
  }

  return Object.entries(positions)
    .map(([model, modelPositions]) => ({
      model,
      average_rank: Math.round((modelPositions.reduce((a, b) => a + b, 0) / modelPositions.length) * 100) / 100,
      rankings_count: modelPositions.length,
      first_place_votes: firstPlace[model] ?? 0,
    }))
    .sort((a, b) => a.average_rank - b.average_rank || b.first_place_votes - a.first_place_votes || a.model.localeCompare(b.model));
}

function buildPreparationBrief(
  userPrompt: string,
  independentTurns: Turn[],
  reviewTurns: Turn[],
  reviewerLabelMaps: Record<string, Record<string, string>>,
  aggregate: Array<{ model: string; average_rank: number; rankings_count: number; first_place_votes: number }>,
): string {
  const answerText = independentTurns
    .map((turn) => `${turn.modelName} independent answer:\n${turn.content}`)
    .join('\n\n');
  const reviewText = reviewTurns
    .map((turn) => `${turn.modelName} anonymous review label map: ${JSON.stringify(reviewerLabelMaps[turn.modelName] ?? {})}\n${turn.content}`)
    .join('\n\n');
  const rankingText = aggregate.length
    ? aggregate.map((item) => `- ${item.model}: avg rank ${item.average_rank} (${item.first_place_votes} first-place vote(s), ${item.rankings_count} ranking(s))`).join('\n')
    : '- No parseable rankings.';

  return (
    `=== Council Preparation Brief ===\n` +
    `User question: ${userPrompt}\n\n` +
    `Independent answers were collected privately before models saw each other.\n\n` +
    `${answerText}\n\n` +
    `Anonymous peer reviews and rankings:\n${reviewText}\n\n` +
    `Aggregate ranking signal:\n${rankingText}\n` +
    `=== End Preparation Brief ===`
  );
}

async function collectText(config: ModelConfig, messages: Message[]): Promise<string> {
  let fullText = '';
  for await (const chunk of streamModel(config, messages)) {
    fullText += chunk;
  }
  return fullText;
}

function shuffledCopy<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
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
  const priorDisplayEntries: DisplayEntry[] = req.prior_display_turns ?? [];

  // Shuffle the panel order. The first model becomes the rotating chair only
  // after all models have produced independent answers.
  const shuffled = shuffledCopy(models);
  const first = shuffled[0];

  yield sse({
    type: 'session_start',
    models: shuffled.map((m) => ({ name: m.name, key: m.name.toLowerCase() })),
  });

  yield sse({
    type: 'preparation_start',
    title: 'Preparing council',
    steps: [
      'Collecting independent answers',
      'Running anonymous peer review',
      'Mapping disagreements',
    ],
  });

  const independentResults = await Promise.all(shuffled.map(async (model) => {
    const userContent = isFollowup
      ? buildConversationText(req.query, [], ragContext, req.prior_conversation)
      : buildUserMessage(req.query, ragContext);
    const messages: Message[] = [
      { role: 'system', content: buildIndependentSystemPrompt(model.name, isFollowup) },
      { role: 'user', content: userContent },
    ];
    try {
      const content = await collectText(model, messages);
      return { turn: { modelName: model.name, role: 'Private Independent Answer', content } as Turn };
    } catch (err) {
      return { error: { model: model.name, message: String(err) } };
    }
  }));

  const independentTurns = independentResults.flatMap((result) => result.turn ? [result.turn] : []);
  for (const result of independentResults) {
    if (result.turn) {
      yield sse({
        type: 'preparation_item',
        stage: 'independent',
        model_key: result.turn.modelName.toLowerCase(),
        name: result.turn.modelName,
        label: `${result.turn.modelName} wrote an independent answer`,
        content: result.turn.content,
      });
    } else if (result.error) {
      yield sse({ type: 'error', model: result.error.model, message: result.error.message });
    }
  }

  if (!independentTurns.length) {
    yield sse({
      type: 'done',
      iterations: 0,
      transcript: null,
      conversation_text: req.prior_conversation ?? '',
      display_turns: priorDisplayEntries,
    });
    return;
  }

  const reviewerLabelMaps: Record<string, Record<string, string>> = {};
  const reviewResults = await Promise.all(shuffled.map(async (model) => {
    const labeledAnswers = shuffledCopy(independentTurns)
      .map((turn, index) => [`Response ${String.fromCharCode(65 + index)}`, turn] as [string, Turn]);
    reviewerLabelMaps[model.name] = Object.fromEntries(
      labeledAnswers.map(([label, turn]) => [label, turn.modelName]),
    );
    const messages: Message[] = [
      { role: 'system', content: buildAnonymousReviewSystemPrompt(model.name) },
      { role: 'user', content: buildAnonymousReviewPrompt(req.query, labeledAnswers) },
    ];
    try {
      const content = await collectText(model, messages);
      return { turn: { modelName: model.name, role: 'Anonymous Peer Review', content } as Turn };
    } catch (err) {
      return { error: { model: model.name, message: String(err) } };
    }
  }));

  const reviewTurns = reviewResults.flatMap((result) => result.turn ? [result.turn] : []);
  for (const result of reviewResults) {
    if (result.turn) {
      yield sse({
        type: 'preparation_item',
        stage: 'review',
        model_key: result.turn.modelName.toLowerCase(),
        name: result.turn.modelName,
        label: `${result.turn.modelName} completed anonymous peer review`,
        content: result.turn.content,
        label_map: reviewerLabelMaps[result.turn.modelName] ?? {},
        ranking: parseRanking(result.turn.content),
      });
    } else if (result.error) {
      yield sse({ type: 'error', model: result.error.model, message: result.error.message });
    }
  }

  const aggregate = aggregateRankings(reviewTurns, reviewerLabelMaps);
  const preparationBrief = buildPreparationBrief(
    req.query, independentTurns, reviewTurns, reviewerLabelMaps, aggregate,
  );

  yield sse({
    type: 'preparation_complete',
    aggregate_rankings: aggregate,
    brief: preparationBrief,
  });

  yield sse({ type: 'iteration', number: 1, max: 1, label: 'Named council discussion' });

  const visibleTurns: Turn[] = [];
  const displayTurns: DisplayTurn[] = [];
  for (const model of shuffled) {
    const conversationText = buildConversationText(
      req.query, visibleTurns, '', preparationBrief,
    );
    const messages: Message[] = [
      { role: 'system', content: buildDiscussionSystemPrompt(model.name) },
      { role: 'user', content: conversationText },
    ];

    const modelKey = model.name.toLowerCase();
    const role = 'Council Discussion';
    yield sse({ type: 'speaker', model_key: modelKey, name: model.name, role });

    let fullText = '';
    try {
      for await (const chunk of streamModel(model, messages)) {
        fullText += chunk;
        yield sse({ type: 'chunk', text: chunk });
      }
    } catch (err) {
      yield sse({ type: 'error', model: model.name, message: String(err) });
      continue;
    }

    const cleanText = fullText.replace(COMPLETE_SIGNAL, '').trim();
    const html = await markdownToHtml(cleanText);
    yield sse({ type: 'turn_end', content: cleanText, html });
    visibleTurns.push({ modelName: model.name, role, content: cleanText });
    displayTurns.push({ kind: 'turn', model_key: modelKey, name: model.name, role, content: cleanText, html });
  }

  const chairConversationText = buildConversationText(
    req.query, visibleTurns, '', preparationBrief,
  );
  const chairMessages: Message[] = [
    { role: 'system', content: buildChairSystemPrompt(first.name) },
    { role: 'user', content: chairConversationText },
  ];

  const chairKey = first.name.toLowerCase();
  const chairRole = 'Final Synthesis';
  yield sse({ type: 'speaker', model_key: chairKey, name: first.name, role: chairRole });

  let chairText = '';
  try {
    for await (const chunk of streamModel(first, chairMessages)) {
      chairText += chunk;
      yield sse({ type: 'chunk', text: chunk });
    }
  } catch (err) {
    yield sse({ type: 'error', model: first.name, message: String(err) });
  }

  if (chairText) {
    const cleanText = chairText.replace(COMPLETE_SIGNAL, '').trim();
    const html = await markdownToHtml(cleanText);
    yield sse({ type: 'turn_end', content: cleanText, html });
    visibleTurns.push({ modelName: first.name, role: chairRole, content: cleanText });
    displayTurns.push({ kind: 'turn', model_key: chairKey, name: first.name, role: chairRole, content: cleanText, html });
  }

  const conversationText = buildConversationText(req.query, visibleTurns, '', preparationBrief);

  // Cumulative display chain: prior thread + this round's question + this round's turns.
  const cumulativeDisplayTurns: DisplayEntry[] = [
    ...priorDisplayEntries,
    { kind: 'user', query: req.query },
    ...displayTurns,
  ];

  yield sse({
    type: 'done',
    iterations: Math.min(maxIterations, 1),
    transcript: null, // Workers don't persist files; history lives client-side
    conversation_text: conversationText,
    display_turns: cumulativeDisplayTurns,
  });
}
