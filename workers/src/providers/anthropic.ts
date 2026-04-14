import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../types.ts';

/**
 * Streams a response from Anthropic Claude.
 * System messages are extracted from the messages array and passed via the
 * dedicated `system` parameter, which is the Anthropic-recommended approach.
 */
export async function* streamAnthropic(
  apiKey: string,
  modelId: string,
  messages: Message[],
): AsyncGenerator<string> {
  const client = new Anthropic({ apiKey });

  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content);
  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const stream = client.messages.stream({
    model: modelId,
    max_tokens: 2048,
    ...(system ? { system } : {}),
    messages: chatMessages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}
