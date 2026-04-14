import { GoogleGenAI } from '@google/genai';
import type { Message } from '../types.ts';

/**
 * Streams a response from Google Gemini via the unified @google/genai SDK.
 * System messages are separated and passed as systemInstruction.
 * Thinking budget mirrors the Python implementation (1024 tokens).
 */
export async function* streamGoogle(
  apiKey: string,
  modelId: string,
  messages: Message[],
): AsyncGenerator<string> {
  const ai = new GoogleGenAI({ apiKey });

  const systemMsg = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');

  // Convert to Google Content format (user → "user", assistant → "model")
  const contents = chatMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const response = ai.models.generateContentStream({
    model: modelId,
    contents,
    config: {
      ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });

  for await (const chunk of await response) {
    const text = chunk.text;
    if (text) yield text;
  }
}
