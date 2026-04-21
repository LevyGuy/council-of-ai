import OpenAI from 'openai';
import type { Message } from '../types.ts';

/**
 * Streams a response from an OpenAI-compatible endpoint.
 * Pass `baseURL` to route to a different provider (e.g. xAI's Grok at
 * https://api.x.ai/v1).
 */
export async function* streamOpenAI(
  apiKey: string,
  modelId: string,
  messages: Message[],
  baseURL?: string,
): AsyncGenerator<string> {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const stream = await client.chat.completions.create({
    model: modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: 2048,
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}
