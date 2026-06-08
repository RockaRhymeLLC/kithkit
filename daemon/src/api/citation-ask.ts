/**
 * Citation S550 Knowledge Base Q&A API
 *
 * POST /portal/citation/api/ask — Answer questions about the Citation S550
 * using ONLY the knowledge base content loaded from disk.
 *
 * Request:  { question, context?, history?, aircraft? }
 * Response: { answer, sources }
 */

import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/logger.js';
import { json, parseBody } from './helpers.js';
import { readKeychain } from '../core/keychain.js';

const log = createLogger('citation-ask');

// ── Knowledge base cache ─────────────────────────────────────

interface KnowledgeBaseSection {
  title: string;
  icon?: string;
  content: string;
}

interface KnowledgeBase {
  lastUpdated?: string;
  aircraft?: Record<string, string>;
  sections: Record<string, KnowledgeBaseSection>;
}

let _kbCache: KnowledgeBase | null = null;
let _kbMtime: number = 0;
let _kbPath: string | null = null;

/**
 * Set the path to the knowledge base JSON file.
 * Must be called before the route handler is invoked.
 */
export function setKnowledgeBasePath(filePath: string): void {
  _kbPath = filePath;
}

/**
 * Load (or reload if changed) the knowledge base from disk.
 * Caches the result and only re-reads if the file mtime has changed.
 */
function loadKnowledgeBase(): KnowledgeBase {
  if (!_kbPath) {
    throw new Error('Knowledge base path not configured');
  }

  try {
    const stat = fs.statSync(_kbPath);
    const mtime = stat.mtimeMs;

    if (_kbCache && mtime === _kbMtime) {
      return _kbCache;
    }

    const raw = fs.readFileSync(_kbPath, 'utf-8');
    const parsed = JSON.parse(raw) as KnowledgeBase;
    _kbCache = parsed;
    _kbMtime = mtime;
    log.info('Knowledge base loaded', { path: _kbPath, sections: Object.keys(parsed.sections).length });
    return parsed;
  } catch (err) {
    throw new Error(`Failed to load knowledge base: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Anthropic API call ───────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
}

async function callAnthropic(
  systemPrompt: string,
  messages: AnthropicMessage[],
): Promise<string> {
  const apiKey = await readKeychain('credential-anthropic-api-key');
  if (!apiKey) {
    throw new Error('Anthropic API key not found in Keychain (credential-anthropic-api-key)');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as AnthropicResponse;
  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('No text content in Anthropic response');
  }
  return textBlock.text;
}

// ── System prompt builder ────────────────────────────────────

function buildSystemPrompt(kb: KnowledgeBase, context?: string): string {
  const sectionNames = Object.values(kb.sections).map(s => s.title).join(', ');

  const kbContent = Object.entries(kb.sections)
    .map(([key, section]) => `## [SECTION: ${section.title} (id: ${key})]\n\n${section.content}`)
    .join('\n\n---\n\n');

  return `You are the Citation S550 Knowledge Base Assistant — an expert on the Cessna Citation S/II (Model S550) business jet.

You have access to the following knowledge base sections: ${sectionNames}.

Your rules:
1. Answer ONLY from the knowledge base content provided below. Do not use outside knowledge.
2. Use markdown formatting in your responses (headers, tables, bullet points as appropriate).
3. At the end of your answer, include a "Sources" section listing the section titles you drew from.
4. If a question is outside the scope of the knowledge base, politely say so and suggest where the user might find that information (e.g., official Cessna documentation, FAA records, COPA forums).
5. Always remind users to verify critical information with official documentation such as the AFM, Maintenance Manual, or FAA records.
6. Do not make up specifications, AD numbers, or maintenance data — only state what is in the knowledge base.
7. Be concise but thorough. Prioritize accuracy over completeness.

${context ? `Current user context: ${context}\n\n` : ''}
---

KNOWLEDGE BASE:

${kbContent}

---

When you reference a section, include the section name so it can be extracted as a source. Your response must end with a JSON block for machine parsing:

\`\`\`json
{"sources": ["Section Title 1", "Section Title 2"]}
\`\`\``;
}

// ── Source extraction ─────────────────────────────────────────

function extractSources(answer: string, kb: KnowledgeBase): { cleanAnswer: string; sources: string[] } {
  // Try to extract the trailing JSON sources block
  const jsonMatch = answer.match(/```json\s*\n?\{"sources":\s*(\[.*?\])\s*\}\s*\n?```/s);
  if (jsonMatch) {
    try {
      const sources = JSON.parse(jsonMatch[1]) as string[];
      const cleanAnswer = answer.slice(0, jsonMatch.index).trimEnd();
      return { cleanAnswer, sources };
    } catch {
      // Fall through to heuristic
    }
  }

  // Heuristic fallback: find any section titles mentioned in the answer
  const sectionTitles = Object.values(kb.sections).map(s => s.title);
  const mentionedSources = sectionTitles.filter(title =>
    answer.toLowerCase().includes(title.toLowerCase()),
  );

  return { cleanAnswer: answer, sources: mentionedSources };
}

// ── Route handler ────────────────────────────────────────────

export async function handleCitationAskRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/portal/citation/api/ask' || req.method !== 'POST') {
    return false;
  }

  // CORS headers — the portal frontend may be loaded from a different origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const body = await parseBody(req);

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) {
      json(res, 400, { error: 'question is required' });
      return true;
    }

    const context = typeof body.context === 'string' ? body.context : undefined;

    // Validate and type-check history
    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history: AnthropicMessage[] = rawHistory
      .filter((m): m is { role: string; content: string } =>
        m !== null &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
      )
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Load knowledge base (cached)
    const kb = loadKnowledgeBase();

    // Build messages array: history + current question
    const messages: AnthropicMessage[] = [
      ...history,
      { role: 'user', content: question },
    ];

    const systemPrompt = buildSystemPrompt(kb, context);

    log.info('Citation ask', {
      questionLength: question.length,
      historyTurns: history.length,
      hasContext: Boolean(context),
    });

    const rawAnswer = await callAnthropic(systemPrompt, messages);
    const { cleanAnswer, sources } = extractSources(rawAnswer, kb);

    json(res, 200, { answer: cleanAnswer, sources });
    return true;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Citation ask error', { error: message });
    json(res, 500, { error: 'Failed to process question', details: message });
    return true;
  }
}
