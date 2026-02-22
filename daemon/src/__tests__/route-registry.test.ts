/**
 * t-202, t-202b, t-203: Route registration API
 *
 * Tests route registration, exact/prefix matching, duplicate detection,
 * and multiple extensions coexisting with separate routes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  _resetRoutesForTesting,
  type RouteHandler,
} from '../core/route-registry.js';

// ── Helpers ──────────────────────────────────────────────────

function createFakeReqRes(method: string, pathname: string): {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  getResponse: () => { status: number; body: string };
} {
  let statusCode = 0;
  let bodyData = '';

  const fakeRes = {
    statusCode: 0,
    headersSent: false,
    writeHead(status: number, _headers?: Record<string, string>) {
      statusCode = status;
      fakeRes.headersSent = true;
      return fakeRes;
    },
    setHeader() { return fakeRes; },
    end(data?: string) {
      if (data) bodyData = data;
    },
  };
  const res = fakeRes as unknown as http.ServerResponse;

  const req = {
    method,
    url: pathname,
    headers: {},
  } as unknown as http.IncomingMessage;

  return {
    req,
    res,
    getResponse: () => ({ status: statusCode, body: bodyData }),
  };
}

function createHandler(responseBody: Record<string, unknown>): RouteHandler {
  return async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
    return true;
  };
}

// ── t-202: Exact and prefix route matching ───────────────────

describe('Route registration handles exact and prefix matching (t-202)', () => {
  beforeEach(() => {
    _resetRoutesForTesting();
  });

  afterEach(() => {
    _resetRoutesForTesting();
  });

  it('registers exact route without error', () => {
    registerRoute('/test/exact', createHandler({ type: 'exact' }));
    const routes = getRegisteredRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0], '/test/exact');
  });

  it('registers prefix route without error', () => {
    registerRoute('/test/prefix/*', createHandler({ type: 'prefix' }));
    const routes = getRegisteredRoutes();
    assert.equal(routes.length, 1);
    assert.equal(routes[0], '/test/prefix/*');
  });

  it('exact route matches exact path only', async () => {
    registerRoute('/test/exact', createHandler({ matched: 'exact' }));

    // Should match exact path
    const { req, res, getResponse } = createFakeReqRes('GET', '/test/exact');
    const handled = await matchRoute(req, res, '/test/exact', new URLSearchParams());
    assert.equal(handled, true);
    assert.equal(getResponse().status, 200);
    assert.ok(getResponse().body.includes('"matched":"exact"'));

    // Should NOT match sub-paths
    const { req: req2, res: res2 } = createFakeReqRes('GET', '/test/exact/sub');
    const handled2 = await matchRoute(req2, res2, '/test/exact/sub', new URLSearchParams());
    assert.equal(handled2, false);
  });

  it('prefix route matches path and sub-paths', async () => {
    registerRoute('/test/prefix/*', createHandler({ matched: 'prefix' }));

    // Should match exact prefix
    const { req: req1, res: res1, getResponse: getRes1 } = createFakeReqRes('GET', '/test/prefix');
    const handled1 = await matchRoute(req1, res1, '/test/prefix', new URLSearchParams());
    assert.equal(handled1, true);
    assert.ok(getRes1().body.includes('"matched":"prefix"'));

    // Should match sub-path
    const { req: req2, res: res2, getResponse: getRes2 } = createFakeReqRes('GET', '/test/prefix/foo/bar');
    const handled2 = await matchRoute(req2, res2, '/test/prefix/foo/bar', new URLSearchParams());
    assert.equal(handled2, true);
    assert.ok(getRes2().body.includes('"matched":"prefix"'));
  });

  it('unmatched path falls through', async () => {
    registerRoute('/test/exact', createHandler({ ok: true }));
    registerRoute('/test/prefix/*', createHandler({ ok: true }));

    const { req, res } = createFakeReqRes('GET', '/test/other');
    const handled = await matchRoute(req, res, '/test/other', new URLSearchParams());
    assert.equal(handled, false);
  });

  it('first matching route wins', async () => {
    registerRoute('/test/overlap/*', async (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ winner: 'first' }));
      return true;
    });
    registerRoute('/test/overlap/specific', async (_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ winner: 'second' }));
      return true;
    });

    const { req, res, getResponse } = createFakeReqRes('GET', '/test/overlap/specific');
    await matchRoute(req, res, '/test/overlap/specific', new URLSearchParams());
    assert.ok(getResponse().body.includes('"winner":"first"'));
  });
});

// ── t-202b: Duplicate route registration fails ──────────────

describe('Duplicate route registration fails gracefully (t-202b)', () => {
  beforeEach(() => {
    _resetRoutesForTesting();
  });

  afterEach(() => {
    _resetRoutesForTesting();
  });

  it('throws error when registering duplicate exact route', () => {
    registerRoute('/test/path', createHandler({ from: 'A' }));

    assert.throws(
      () => registerRoute('/test/path', createHandler({ from: 'B' })),
      (err: Error) => {
        assert.ok(err.message.includes('/test/path'));
        assert.ok(err.message.includes('already registered'));
        return true;
      },
    );
  });

  it('throws error when registering duplicate prefix route', () => {
    registerRoute('/test/prefix/*', createHandler({ from: 'A' }));

    assert.throws(
      () => registerRoute('/test/prefix/*', createHandler({ from: 'B' })),
      (err: Error) => {
        assert.ok(err.message.includes('/test/prefix/*'));
        return true;
      },
    );
  });

  it('original handler still responds after failed duplicate registration', async () => {
    registerRoute('/test/path', createHandler({ from: 'A' }));

    try {
      registerRoute('/test/path', createHandler({ from: 'B' }));
    } catch {
      // Expected
    }

    const { req, res, getResponse } = createFakeReqRes('GET', '/test/path');
    const handled = await matchRoute(req, res, '/test/path', new URLSearchParams());
    assert.equal(handled, true);
    assert.ok(getResponse().body.includes('"from":"A"'), 'Original handler A should respond');
  });

  it('different patterns are allowed', () => {
    registerRoute('/test/path-a', createHandler({ from: 'A' }));
    registerRoute('/test/path-b', createHandler({ from: 'B' }));

    const routes = getRegisteredRoutes();
    assert.equal(routes.length, 2);
  });
});

// ── t-203: Multiple extensions register routes without conflicts ─

describe('Multiple extensions register routes without conflicts (t-203)', () => {
  beforeEach(() => {
    _resetRoutesForTesting();
  });

  afterEach(() => {
    _resetRoutesForTesting();
  });

  it('two extensions register different routes', () => {
    // Extension A registers its routes
    registerRoute('/ext-a/hello', createHandler({ from: 'ext-a' }));

    // Extension B registers its routes
    registerRoute('/ext-b/hello', createHandler({ from: 'ext-b' }));

    const routes = getRegisteredRoutes();
    assert.equal(routes.length, 2);
    assert.ok(routes.includes('/ext-a/hello'));
    assert.ok(routes.includes('/ext-b/hello'));
  });

  it('extension A route responds correctly', async () => {
    registerRoute('/ext-a/hello', createHandler({ from: 'ext-a' }));
    registerRoute('/ext-b/hello', createHandler({ from: 'ext-b' }));

    const { req, res, getResponse } = createFakeReqRes('GET', '/ext-a/hello');
    const handled = await matchRoute(req, res, '/ext-a/hello', new URLSearchParams());
    assert.equal(handled, true);
    assert.ok(getResponse().body.includes('"from":"ext-a"'));
  });

  it('extension B route responds correctly', async () => {
    registerRoute('/ext-a/hello', createHandler({ from: 'ext-a' }));
    registerRoute('/ext-b/hello', createHandler({ from: 'ext-b' }));

    const { req, res, getResponse } = createFakeReqRes('GET', '/ext-b/hello');
    const handled = await matchRoute(req, res, '/ext-b/hello', new URLSearchParams());
    assert.equal(handled, true);
    assert.ok(getResponse().body.includes('"from":"ext-b"'));
  });

  it('registered routes appear in getRegisteredRoutes()', () => {
    registerRoute('/ext-a/hello', createHandler({ from: 'ext-a' }));
    registerRoute('/ext-b/hello', createHandler({ from: 'ext-b' }));
    registerRoute('/ext-c/data/*', createHandler({ from: 'ext-c' }));

    const routes = getRegisteredRoutes();
    assert.equal(routes.length, 3);
    assert.deepEqual(routes, ['/ext-a/hello', '/ext-b/hello', '/ext-c/data/*']);
  });

  it('prefix and exact routes from different extensions coexist', async () => {
    registerRoute('/ext-a/api/*', createHandler({ from: 'ext-a-prefix' }));
    registerRoute('/ext-b/status', createHandler({ from: 'ext-b-exact' }));

    // Prefix route matches
    const { req: r1, res: s1, getResponse: g1 } = createFakeReqRes('GET', '/ext-a/api/users');
    assert.equal(await matchRoute(r1, s1, '/ext-a/api/users', new URLSearchParams()), true);
    assert.ok(g1().body.includes('ext-a-prefix'));

    // Exact route matches
    const { req: r2, res: s2, getResponse: g2 } = createFakeReqRes('GET', '/ext-b/status');
    assert.equal(await matchRoute(r2, s2, '/ext-b/status', new URLSearchParams()), true);
    assert.ok(g2().body.includes('ext-b-exact'));
  });
});
