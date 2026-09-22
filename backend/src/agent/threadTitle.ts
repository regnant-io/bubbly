import { callModel } from '../models/index';
import { logger } from '../utils/logger';
import type { AgentConfig } from '../types';

const MAX_TITLE_LENGTH = 64;

/** Keep model output usable as a single-line application title. */
export function cleanThreadTitle(raw: string, sourceMessage: string): string {
  const cleaned = raw
    .trim()
    .replace(/^(title|thread title)\s*:\s*/i, '')
    .replace(/^[\s"'`#*-]+|[\s"'`#*.:-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) return cleaned.slice(0, MAX_TITLE_LENGTH).trim();

  // A title should never block thread creation. This is only used when the
  // configured model is unavailable or returns an empty response.
  const fallback = sourceMessage
    .replace(/\[[^\]]*attached[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
  return (fallback || 'New conversation').slice(0, MAX_TITLE_LENGTH).trim();
}

/** Generate the title before the main agent turn begins. */
export async function generateThreadTitle(params: {
  config: AgentConfig;
  message: string;
  signal?: AbortSignal;
}): Promise<string> {
  const source = params.message.slice(0, 4_000);
  try {
    const response = await callModel({
      config: { ...params.config, maxTokens: 48 },
      systemPrompt:
        'Create a short title for a software-development conversation. ' +
        'Return only the title: 3-8 words, sentence case, no quotes, no period, no prefix.',
      messages: [{ role: 'user', content: source }],
      tools: [],
      signal: params.signal,
    });
    return cleanThreadTitle(response.textContent, source);
  } catch (error) {
    logger.warn('Thread title generation failed; using a compact fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return cleanThreadTitle('', source);
  }
}
