/**
 * PDF Search — Indexer.
 *
 * Folder scan → PDF text extract (pdftotext) → chunk → embed (LM Studio) → store.
 *
 * Uses pdftotext CLI (poppler-utils) to extract text.
 * pdftotext outputs form-feed characters (\f) as page separators.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createLogger } from '../../core/logger.js';
import {
  updateFolderStatus,
  deleteFolderChunks,
  insertChunkWithVector,
  getChunkCount,
  type Folder,
} from './db.js';

const log = createLogger('pdfsearch-indexer');

const LM_STUDIO_URL = 'http://100.116.148.95:1234';
const EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const CHUNK_SIZE = 1000;    // chars
const CHUNK_OVERLAP = 150;  // chars

/**
 * Maximum time (ms) allowed for processing a single file (text extraction +
 * embedding).  If a file exceeds this deadline, it is warned and skipped so
 * the rest of the folder continues.  The primary culprit is pdftotext on
 * scanned/image-only PDFs: the child process may ignore SIGTERM, leaving the
 * execFile callback in a permanently-pending state and stalling the entire run.
 */
const FILE_EXTRACTION_TIMEOUT_MS = 60_000;

// ── State ─────────────────────────────────────────────────────

interface IndexProgress {
  folderId: number;
  folderPath: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  currentFile: string | null;
  startedAt: string;
  error: string | null;
}

let _progress: IndexProgress | null = null;

export function getIndexProgress(): IndexProgress | null {
  return _progress;
}

export function isIndexing(): boolean {
  return _progress !== null;
}

// ── Embedding ─────────────────────────────────────────────────

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

// ── Text extraction ────────────────────────────────────────────

/**
 * If the file is an iCloud-evicted placeholder (blocks=0 but size>0),
 * call `brctl download` to materialize it. Polls up to `timeoutMs` for
 * blocks > 0. Returns when ready, or throws if we time out.
 *
 * Without this, pdftotext (and most other readers) hit EDEADLK
 * ("Resource deadlock avoided") on the first read attempt because
 * macOS can't fault the file in from iCloud automatically for processes
 * spawned outside a logged-in user GUI session.
 */
async function ensureFileMaterialized(filePath: string, timeoutMs = 30_000): Promise<void> {
  const s = await stat(filePath);
  // s.blocks of 0 with size > 0 is the eviction signature on APFS
  if (s.blocks > 0 || s.size === 0) return;

  log.debug('PDF is iCloud-evicted placeholder, materializing', {
    file: filePath,
    size: s.size,
  });

  await new Promise<void>((resolve, reject) => {
    execFile('brctl', ['download', filePath], { timeout: timeoutMs }, (err) => {
      if (err) reject(new Error(`brctl download failed for ${filePath}: ${err.message}`));
      else resolve();
    });
  });

  // Poll until blocks > 0 (brctl can return before the file is fully synced
  // to local disk; on a fast LAN-cached AppleID this is usually <2s).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s2 = await stat(filePath);
    if (s2.blocks > 0) return;
    await new Promise(r => setTimeout(r, 250));
  }

  throw new Error(`File still evicted after brctl download (${timeoutMs}ms): ${filePath}`);
}

async function extractPdfText(filePath: string): Promise<string> {
  await ensureFileMaterialized(filePath);

  return new Promise((resolve, reject) => {
    execFile(
      'pdftotext',
      ['-layout', filePath, '-'],
      { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`pdftotext failed for ${filePath}: ${err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ── Markdown text extraction ───────────────────────────────────

/**
 * Known failed-export stub signatures. Files whose raw content matches any of
 * these patterns contain no useful content and are skipped during indexing.
 *
 *  • OneNote export stubs: frontmatter contains `export_error:` key
 *  • Granola transcript stubs: body contains `[TRANSCRIPT UNAVAILABLE`
 *  • Remarkable download stubs: body contains `[ILLEGIBLE - PDF download failed`
 */
const STUB_PATTERNS: RegExp[] = [
  /^export_error:\s/m,
  /\[TRANSCRIPT UNAVAILABLE/,
  /\[ILLEGIBLE - PDF download failed/,
];

function isStubFile(rawContent: string): boolean {
  return STUB_PATTERNS.some(re => re.test(rawContent));
}

interface MarkdownSection {
  /** Heading text (empty string if none) */
  heading: string;
  /** Body text under this heading */
  body: string;
  /** 1-based section index — stored as page_number in the DB */
  index: number;
}

/**
 * Extract logical sections from a Markdown file.
 * Strips YAML frontmatter, splits on # / ## headings, and returns one
 * MarkdownSection per heading block.  Falls back to a single section for
 * files without headings.
 *
 * Returns null if the file matches a known failed-export stub pattern.
 */
async function extractMarkdownText(filePath: string): Promise<MarkdownSection[] | null> {
  const raw = await readFile(filePath, 'utf-8');

  // Stub detection runs on the full raw content (frontmatter included)
  if (isStubFile(raw)) {
    return null;
  }

  // Strip YAML frontmatter (opening --- must be at byte 0)
  let body = raw;
  if (raw.startsWith('---')) {
    const fmEnd = raw.indexOf('\n---', 3);
    if (fmEnd !== -1) {
      body = raw.slice(fmEnd + 4).trimStart();
    }
  }

  if (!body.trim()) return [];

  // Split into sections on level-1 or level-2 headings
  const lines = body.split('\n');
  const sections: MarkdownSection[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];
  let sectionIdx = 0;

  const flush = (): void => {
    const text = currentLines.join('\n').trim();
    if (text.length >= 20) {
      sections.push({ heading: currentHeading, body: text, index: ++sectionIdx });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (/^#{1,2} /.test(line)) {
      flush();
      currentHeading = line.replace(/^#{1,2} /, '').trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // No headings found → treat the entire body as a single section
  if (sections.length === 0) {
    const text = body.trim();
    if (text.length >= 20) {
      sections.push({ heading: '', body: text, index: 1 });
    }
  }

  return sections;
}

// ── Markdown indexing ──────────────────────────────────────────

/**
 * Index a single Markdown file.
 *
 * Returns:
 *  -1  → file was a known stub (caller increments stub counter, no error)
 *   0  → file had no extractable content
 *  >0  → number of chunks successfully embedded and stored
 */
async function indexMd(folderId: number, filePath: string): Promise<number> {
  let sections: MarkdownSection[] | null;
  try {
    sections = await extractMarkdownText(filePath);
  } catch (err) {
    log.warn('Markdown text extraction failed, skipping', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (sections === null) {
    log.debug('Skipping stub markdown file', { file: filePath });
    return -1; // sentinel: stub
  }

  if (sections.length === 0) {
    log.debug('Markdown has no extractable content, skipping', { file: filePath });
    return 0;
  }

  let chunkCount = 0;

  for (const section of sections) {
    // Prepend heading to body so embedded chunks carry their context
    const sectionText = section.heading
      ? `${section.heading}\n\n${section.body}`
      : section.body;

    // For large sections fall back to the fixed-size chunker; small ones are a single chunk
    const chunks = sectionText.length > CHUNK_SIZE
      ? chunkText(sectionText)
      : [{ text: sectionText.trim(), charStart: 0, charEnd: sectionText.length }];

    for (const chunk of chunks) {
      if (chunk.text.length < 20) continue;
      try {
        const embedding = await fetchEmbedding(chunk.text);
        insertChunkWithVector(
          folderId,
          filePath,
          section.index,   // stored as page_number
          chunk.text,
          chunk.charStart,
          chunk.charEnd,
          embedding,
        );
        chunkCount++;
      } catch (err) {
        log.warn('Failed to embed markdown chunk, skipping', {
          file: filePath,
          section: section.index,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return chunkCount;
}

// ── Chunking ──────────────────────────────────────────────────

interface TextChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    let chunkEnd = end;

    // Try to break on whitespace if not at end of text
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start + CHUNK_SIZE / 2) {
        chunkEnd = lastSpace + 1;
      }
    }

    const chunkText = text.slice(start, chunkEnd).trim();
    if (chunkText.length >= 20) { // Skip tiny fragments
      chunks.push({ text: chunkText, charStart: start, charEnd: chunkEnd });
    }

    // Advance with overlap
    start = Math.max(start + 1, chunkEnd - CHUNK_OVERLAP);
  }

  return chunks;
}

// ── PDF indexing ───────────────────────────────────────────────

async function indexPdf(
  folderId: number,
  filePath: string,
): Promise<number> {
  let rawText: string;
  try {
    rawText = await extractPdfText(filePath);
  } catch (err) {
    log.warn('PDF text extraction failed, skipping', {
      file: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (!rawText.trim()) {
    log.debug('PDF has no extractable text, skipping', { file: filePath });
    return 0;
  }

  // Split on form feeds (\f) = page breaks
  const pages = rawText.split('\f');
  let chunkCount = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = pages[pageIdx].trim();
    if (!pageText) continue;

    const pageNumber = pageIdx + 1;
    const chunks = chunkText(pageText);

    for (const chunk of chunks) {
      try {
        const embedding = await fetchEmbedding(chunk.text);
        insertChunkWithVector(
          folderId,
          filePath,
          pageNumber,
          chunk.text,
          chunk.charStart,
          chunk.charEnd,
          embedding,
        );
        chunkCount++;
      } catch (err) {
        log.warn('Failed to embed chunk, skipping', {
          file: filePath,
          page: pageNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return chunkCount;
}

// ── Per-file timeout ───────────────────────────────────────────

/**
 * Races `promise` against a wall-clock timeout.  If the timeout fires first,
 * rejects with a descriptive error naming the offending file.  This is a
 * higher-level guard on top of the `execFile` `timeout` option: if pdftotext
 * ignores SIGTERM and never exits, the execFile callback is never called and
 * the inner promise hangs forever — only an external race can break it.
 */
function withFileTimeout<T>(promise: Promise<T>, filePath: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `File extraction timed out after ${FILE_EXTRACTION_TIMEOUT_MS}ms: ${filePath}`,
      ));
    }, FILE_EXTRACTION_TIMEOUT_MS);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Folder scan ────────────────────────────────────────────────

async function findIndexableFiles(folderPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name.endsWith('.pdf') || name.endsWith('.md')) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(folderPath);
  return files;
}

// ── Main indexer ───────────────────────────────────────────────

export async function indexFolder(folder: Folder): Promise<void> {
  if (_progress) {
    log.warn('Indexer already running, skipping', { folderId: folder.id });
    return;
  }

  _progress = {
    folderId: folder.id,
    folderPath: folder.path,
    totalFiles: 0,
    processedFiles: 0,
    totalChunks: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
    error: null,
  };

  updateFolderStatus(folder.id, 'indexing');

  try {
    log.info('Scanning folder for indexable files', { folder: folder.path });
    const files = await findIndexableFiles(folder.path);

    _progress.totalFiles = files.length;
    updateFolderStatus(folder.id, 'indexing', { file_count: files.length });

    log.info('Found files to index', { count: files.length, folder: folder.path });

    // Clear existing chunks for this folder (re-index)
    deleteFolderChunks(folder.id);

    let totalChunks = 0;
    let filesWithZeroChunks = 0;
    let stubsSkipped = 0;
    for (const filePath of files) {
      _progress.currentFile = filePath;

      const isMd = filePath.toLowerCase().endsWith('.md');
      log.debug(isMd ? 'Indexing markdown' : 'Indexing PDF', { file: filePath });

      let chunkCount: number;
      try {
        if (isMd) {
          chunkCount = await withFileTimeout(indexMd(folder.id, filePath), filePath);
          if (chunkCount < 0) {
            // Stub sentinel — do not count as zero-chunk failure
            stubsSkipped++;
            _progress.processedFiles++;
            continue;
          }
        } else {
          chunkCount = await withFileTimeout(indexPdf(folder.id, filePath), filePath);
        }
      } catch (err) {
        // Timeout or unexpected per-file error — warn and skip, never abort the folder.
        log.warn('File skipped due to timeout or error', {
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        _progress.processedFiles++;
        filesWithZeroChunks++;
        continue;
      }

      totalChunks += chunkCount;
      _progress.totalChunks = totalChunks;
      _progress.processedFiles++;
      if (chunkCount === 0) filesWithZeroChunks++;

      log.debug('File indexed', { file: filePath, chunks: chunkCount });
    }

    if (stubsSkipped > 0) {
      log.info('Skipped stub files during indexing', {
        folder: folder.path,
        stubs: stubsSkipped,
      });
    }

    // Guard against silent-success: if every real (non-stub) file failed extraction,
    // mark the folder as 'error' instead of 'done' so the operator notices.
    const realFiles = files.length - stubsSkipped;
    if (realFiles > 0 && totalChunks === 0) {
      const msg =
        `Indexer produced 0 chunks across ${realFiles} real files (${stubsSkipped} stubs skipped) — ` +
        `text extraction failed for every file. Common causes: ` +
        `iCloud-evicted placeholders (check ` + '`stat -f "%b" <file>`' + ` reports 0), ` +
        `scanned/image-only PDFs needing OCR, or encrypted PDFs. ` +
        `See daemon log for per-file errors.`;
      log.error('Folder indexing produced zero chunks', {
        folder: folder.path,
        files: realFiles,
        stubs: stubsSkipped,
      });
      updateFolderStatus(folder.id, 'error', {
        file_count: files.length,
        error_message: msg,
      });
      return;
    }

    updateFolderStatus(folder.id, 'done', {
      file_count: files.length,
      last_indexed_at: new Date().toISOString(),
    });

    log.info('Folder indexing complete', {
      folder: folder.path,
      files: files.length,
      stubs: stubsSkipped,
      chunks: totalChunks,
      filesWithZeroChunks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Folder indexing failed', { folder: folder.path, error: msg });
    updateFolderStatus(folder.id, 'error', { error_message: msg });
    if (_progress) _progress.error = msg;
  } finally {
    _progress = null;
  }
}

// Exported for unit testing only — not part of the public API.
export { withFileTimeout as _withFileTimeoutForTesting, FILE_EXTRACTION_TIMEOUT_MS };
