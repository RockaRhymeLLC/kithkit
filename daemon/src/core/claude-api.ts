/**
 * Lightweight Claude API client for daemon tasks.
 *
 * Uses native fetch to call the Anthropic Messages API.
 * Intended for structured analysis tasks (email triage, etc.)
 * where a quick Sonnet call is more capable than regex.
 *
 * Non-throwing: returns null on any failure for daemon resilience.
 */

import { readKeychain } from './keychain.js';
import { createLogger } from './logger.js';

const log = createLogger('claude-api');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

export interface ClaudeResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AskClaudeOptions {
  model?: string;
  maxTokens?: number;
  system?: string;
  timeoutMs?: number;
}

/**
 * Send a prompt to Claude and get a text response.
 * Returns null on failure (non-throwing for daemon resilience).
 */
export async function askClaude(
  prompt: string,
  options?: AskClaudeOptions,
): Promise<ClaudeResponse | null> {
  const apiKey = await readKeychain('credential-anthropic-api-key');
  if (!apiKey) {
    log.error('No Anthropic API key found in Keychain');
    return null;
  }

  const body = {
    model: options?.model ?? DEFAULT_MODEL,
    max_tokens: options?.maxTokens ?? 1024,
    ...(options?.system ? { system: options.system } : {}),
    messages: [{ role: 'user', content: prompt }],
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error(`Claude API error: HTTP ${res.status}`, { body: errText.slice(0, 200) });
      return null;
    }

    const data = await res.json() as any;
    const text = data.content?.[0]?.text ?? '';
    return {
      content: text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    log.error('Claude API call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
