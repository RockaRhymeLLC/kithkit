/**
 * PDF Search — Route handlers.
 *
 * POST  /api/pdf-search/folders           — add folder + kick off indexing
 * GET   /api/pdf-search/folders           — list folders + status
 * POST  /api/pdf-search/folders/:id/reindex — force reindex
 * GET   /api/pdf-search/status            — indexing progress
 * POST  /api/pdf-search/query             — semantic search + LLM answer
 * GET   /api/pdf-search/file?path=        — serve raw PDF (path security check)
 * POST  /api/pdf-search/login             — validate password (if auth enabled)
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseBody } from '../../api/helpers.js';
import { createLogger } from '../../core/logger.js';
import {
  addFolder,
  listFolders,
  getFolder,
  getFolderByPath,
  type Folder,
} from './db.js';
import { indexFolder, getIndexProgress, isIndexing } from './indexer.js';
import { searchDocuments } from './search.js';

const log = createLogger('pdfsearch-routes');

// ── Auth state (set by index.ts after keychain read) ──────────

let _password: string | null = null;

export function setPdfSearchPassword(pw: string | null): void {
  _password = pw;
}

export function getPdfSearchPassword(): string | null {
  return _password;
}

// ── Auth helper ───────────────────────────────────────────────

function checkAuth(req: http.IncomingMessage): boolean {
  if (!_password) return true; // No password configured — open access

  const authHeader = req.headers['authorization'] ?? '';
  if (!authHeader.startsWith('Basic ')) return false;

  const b64 = authHeader.slice(6);
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  return pass === _password;
}

function sendUnauth(res: http.ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="PDF Search"',
  });
  res.end(JSON.stringify({ error: 'Authentication required' }));
}

// ── Path security check ───────────────────────────────────────

function isPathAllowed(filePath: string): boolean {
  const folders = listFolders();
  const normalized = filePath.replace(/\\/g, '/');
  return folders.some(f => normalized.startsWith(f.path.replace(/\\/g, '/')));
}

// ── Handlers ──────────────────────────────────────────────────

async function handleAddFolder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  try {
    const body = await parseBody(req);
    const { path: folderPath } = body as { path?: string };

    if (!folderPath || typeof folderPath !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path is required' }));
      return true;
    }

    // Check if path exists
    try {
      const s = await stat(folderPath);
      if (!s.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'path is not a directory' }));
        return true;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path does not exist' }));
      return true;
    }

    const folder = addFolder(folderPath);

    // Kick off background indexing
    if (!isIndexing()) {
      indexFolder(folder).catch(err => {
        log.error('Background indexing failed', {
          folder: folderPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, folder }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Add folder failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListFolders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  try {
    const folders = listFolders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ folders }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleReindex(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  const match = pathname.match(/\/api\/pdf-search\/folders\/(\d+)\/reindex$/);
  if (!match) return false;

  const folderId = parseInt(match[1], 10);

  try {
    const folder = getFolder(folderId);
    if (!folder) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Folder not found' }));
      return true;
    }

    if (isIndexing()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Indexer already running' }));
      return true;
    }

    indexFolder(folder).catch(err => {
      log.error('Reindex failed', {
        folderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Reindexing started' }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  const progress = getIndexProgress();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    indexing: isIndexing(),
    progress,
    auth: _password ? 'enabled' : 'open',
  }));
  return true;
}

async function handleQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  try {
    const body = await parseBody(req);
    const { q, folderId } = body as { q?: string; folderId?: number };

    if (!q || typeof q !== 'string' || !q.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'q (query) is required' }));
      return true;
    }

    const result = await searchDocuments(q.trim(), folderId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Query failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleServeFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!checkAuth(req)) { sendUnauth(res); return true; }

  const filePath = searchParams.get('path');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'path query param is required' }));
    return true;
  }

  // Security: only serve files under registered folders
  if (!isPathAllowed(filePath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Path not in any registered folder' }));
    return true;
  }

  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': s.size,
      'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
  }
  return true;
}

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await parseBody(req);
    const { password } = body as { password?: string };

    if (!_password) {
      // No auth configured — always OK
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, authEnabled: false }));
      return true;
    }

    if (password === _password) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, authEnabled: true }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid password' }));
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
  return true;
}

// ── Dispatcher ─────────────────────────────────────────────────

export async function handlePdfSearchRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (pathname === '/api/pdf-search/folders' && req.method === 'POST') {
    return handleAddFolder(req, res);
  }
  if (pathname === '/api/pdf-search/folders' && req.method === 'GET') {
    return handleListFolders(req, res);
  }
  if (/\/api\/pdf-search\/folders\/\d+\/reindex$/.test(pathname)) {
    return handleReindex(req, res, pathname);
  }
  if (pathname === '/api/pdf-search/status') {
    return handleStatus(req, res);
  }
  if (pathname === '/api/pdf-search/query') {
    return handleQuery(req, res);
  }
  if (pathname === '/api/pdf-search/file') {
    return handleServeFile(req, res, pathname, searchParams);
  }
  if (pathname === '/api/pdf-search/login') {
    return handleLogin(req, res);
  }
  return false;
}
