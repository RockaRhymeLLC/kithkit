/**
 * PDF Search — Semantic search + LLM answer generation.
 *
 * Embeds the query → vector KNN retrieve top-K → build context → ask qwen.
 */

import { createLogger } from '../../core/logger.js';
import { vectorSearchChunks, type Chunk } from './db.js';

const log = createLogger('pdfsearch-search');

const LM_STUDIO_URL = 'http://100.116.148.95:1234';
const EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const CHAT_MODEL = 'nvidia/nemotron-3-nano-omni';
const TOP_K = 8;

// ── Types ──────────────────────────────────────────────────────

export interface Citation {
  file_path: string;
  file_name: string;
  page_number: number;
  chunk_text: string;
  score: number;
}

export interface SearchResult {
  answer: string;
  citations: Citation[];
  query: string;
}

// ── Embedding ──────────────────────────────────────────────────

async function fetchEmbedding(text: string): Promise<Float32Array> {
  const resp = await fetch(`${LM_STUDIO_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!resp.ok) {
    throw new Error(`Embedding API ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  const vec = data.data[0]?.embedding;
  if (!vec || vec.length === 0) {
    throw new Error('Embedding API returned empty vector');
  }

  return new Float32Array(vec);
}

// ── LLM answer ─────────────────────────────────────────────────

async function generateAnswer(query: string, chunks: Array<Chunk & { distance: number }>): Promise<string> {
  if (chunks.length === 0) {
    return "I don't have any indexed documents to search. Please add a folder and wait for indexing to complete.";
  }

  // Build context from top chunks
  const contextParts = chunks.map((c, i) => {
    const fileName = c.file_path.split('/').pop() ?? c.file_path;
    return `[${i + 1}] Source: ${fileName}, Page ${c.page_number}\n${c.chunk_text}`;
  });

  const context = contextParts.join('\n\n---\n\n');

  const systemPrompt = `You are a precise document assistant.

CRITICAL OUTPUT FORMAT — you MUST follow this exactly:
- You may think or reason internally before answering (that is fine).
- Your complete, final, user-facing answer MUST be wrapped in <ANSWER> and </ANSWER> tags.
- Put NOTHING else inside those tags — no reasoning, no preamble, no meta-commentary, no self-assessment. Only the polished answer the user will read.
- Example format:
  <ANSWER>
  The report states that revenue increased by 12% in Q3 [annual-report.pdf:4].
  </ANSWER>

Answer rules (apply inside <ANSWER>):
- Answer directly using ONLY the provided document excerpts
- Cite sources inline as [file:page] (e.g., [report.pdf:3]) when referencing information
- If the context doesn't contain the answer, say "I don't know" — do not guess
- Be concise and direct
- Use plain text, no markdown headers`;

  const userMessage = `Document excerpts:\n\n${context}\n\n---\n\nQuestion: ${query}`;

  const resp = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as {
    choices: Array<{
      message: {
        content: string | null;
        reasoning_content?: string | null;
      };
    }>;
  };

  // (a) Strip <think>...</think> blocks — qwen3 thinking-mode artifacts that can leak
  // into content even when reasoning_content is also populated.
  const rawContent = data.choices[0]?.message?.content ?? '';
  let cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // (b) Extract <ANSWER>...</ANSWER> — the model is instructed to wrap its final
  // user-facing answer in this delimiter so we can ignore any preamble or reasoning.
  // We use the LAST opening tag to handle models that emit multiple candidates.
  const answerOpenRe = /<answer>/gi;
  const answerCloseRe = /<\/answer>/i;
  let extracted = '';

  const allOpenMatches = [...cleaned.matchAll(answerOpenRe)];
  if (allOpenMatches.length > 0) {
    const lastOpen = allOpenMatches[allOpenMatches.length - 1];
    const afterOpen = cleaned.slice(lastOpen.index! + lastOpen[0].length);
    const closeMatch = afterOpen.match(answerCloseRe);
    if (closeMatch) {
      // Both opening and closing tag found — extract content between them
      extracted = afterOpen.slice(0, closeMatch.index).trim();
    } else {
      // Opening tag found but no closing tag — take everything after the opening tag
      extracted = afterOpen.trim();
    }
  }

  // Use extracted content if non-empty; otherwise fall back to cleaned (post-<think>-strip)
  let answer = extracted || cleaned;

  // (c) Strip a leading reasoning preamble conservatively (kept as additional fallback).
  // Only acts when the response clearly opens with an explicit "thinking process" /
  // "reasoning" header AND there is substantive content after it (≥30 chars).
  const PREAMBLE_TRIGGER = /^(?:here(?:'s| is)(?: a| my)? (?:thinking(?: process)?|reasoning|thought process)\b|thinking:|reasoning:)/i;
  if (PREAMBLE_TRIGGER.test(answer)) {
    const lastBreak = answer.lastIndexOf('\n\n');
    if (lastBreak !== -1) {
      const candidate = answer.slice(lastBreak).trim();
      if (candidate.length >= 30) {
        answer = candidate;
      }
    }
  }

  if (!answer) {
    throw new Error('LLM returned empty response');
  }

  return answer;
}

// ── Main search function ───────────────────────────────────────

export async function searchDocuments(
  query: string,
  folderId?: number | number[],
): Promise<SearchResult> {
  log.debug('Starting search', { query, folderId });

  // Embed the query
  const queryEmbedding = await fetchEmbedding(query);

  // Vector KNN retrieve
  const chunks = vectorSearchChunks(queryEmbedding, TOP_K, folderId);
  log.debug('Retrieved chunks', { count: chunks.length });

  // Generate answer
  const answer = await generateAnswer(query, chunks);

  // Build citations
  const citations: Citation[] = chunks.map(c => {
    // Convert L2 distance to similarity score (0-1)
    const score = Math.max(0, 1 - (c.distance * c.distance) / 2);
    return {
      file_path: c.file_path,
      file_name: c.file_path.split('/').pop() ?? c.file_path,
      page_number: c.page_number,
      chunk_text: c.chunk_text.slice(0, 300) + (c.chunk_text.length > 300 ? '…' : ''),
      score,
    };
  });

  return { answer, citations, query };
}
