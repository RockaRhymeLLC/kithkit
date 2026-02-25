/**
 * t-240: Cowork bridge WebSocket handshake and framing
 * t-241: Cowork bridge REST API routes
 * t-242: Cowork bridge public API — sendCdpCommand, listTabs, switchTab
 * t-007: Cowork bridge key exchange (X25519 ECDH + PSK-HKDF)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  initCoworkBridge,
  isCoworkConnected,
  getCoworkStatus,
  sendCdpCommand,
  listTabs,
  switchTab,
  shutdownCoworkBridge,
  handleCoworkRoute,
  setAuthToken,
  setPsk,
  _resetCoworkBridgeForTesting,
} from '../extensions/cowork-bridge.js';
import {
  generateEphemeralKeyPair,
  computeSharedSecret,
  deriveSessionKey,
  encryptEnvelope,
  decryptEnvelope,
  type EncryptedEnvelope,
} from '../extensions/cowork-crypto.js';

// ── Helpers ───────────────────────────────────────────────────

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB5E4F89F5';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Perform a WebSocket handshake against `host:port` at `path`.
 * Returns the raw TCP socket with upgrade completed.
 */
function wsConnect(port: number, path = '/cowork'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: localhost:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
      );
    });

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('binary');
      if (buf.includes('\r\n\r\n')) {
        const statusLine = buf.split('\r\n')[0];
        if (statusLine.includes('101')) {
          socket.removeListener('data', onData);
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`Unexpected upgrade response: ${statusLine}`));
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** Build a masked WebSocket text frame (client → server frames must be masked). */
function buildTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);

  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x81;           // FIN + text
    header[1] = 0x80 | len;     // masked
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }

  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

/** Build a masked WebSocket close frame (client → server). */
function buildCloseFrame(code = 1000): Buffer {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code, 0);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(2);
  for (let i = 0; i < 2; i++) masked[i] = payload[i] ^ mask[i % 4];
  const frame = Buffer.allocUnsafe(2 + 4 + 2);
  frame[0] = 0x88; // FIN + close
  frame[1] = 0x80 | 2; // masked + len 2
  mask.copy(frame, 2);
  masked.copy(frame, 6);
  return frame;
}

/** Parse a single server-sent (unmasked) text frame from a buffer. */
function parseServerFrame(buf: Buffer): { text: string; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  }
  if (buf.length < offset + payloadLen) return null;
  if (opcode !== 0x01) return null; // only handle text
  return {
    text: buf.subarray(offset, offset + payloadLen).toString('utf-8'),
    consumed: offset + payloadLen,
  };
}

/**
 * Read a single server-sent text frame from a WebSocket.
 * Waits up to `timeoutMs` for data to arrive.
 */
function readServerFrame(socket: net.Socket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('readServerFrame timeout'));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseServerFrame(buf);
      if (parsed) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(parsed.text);
      }
    };
    socket.on('data', onData);
  });
}

/**
 * Create and start a minimal HTTP server with the cowork bridge attached.
 * The server routes /api/cowork/* requests through handleCoworkRoute.
 */
function createBridgeServer(port: number): {
  server: http.Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const server = http.createServer((req, res) => {
    // Route /api/cowork/* through handleCoworkRoute
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/cowork')) {
      handleCoworkRoute(req, res, pathname, url.searchParams).then(handled => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  initCoworkBridge(server);

  return {
    server,
    start: () => new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve)),
    stop: () => new Promise<void>(resolve => {
      // Force-close all connections first, then stop accepting new ones.
      // Use a timeout fallback in case server.close() stalls.
      server.closeAllConnections();
      const timer = setTimeout(() => resolve(), 500);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    }),
  };
}

/** HTTP request helper. */
function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

/**
 * Gracefully close a WebSocket by sending a close frame and waiting for the
 * socket's close event. Falls back to destroy() if no close event arrives
 * within the timeout.
 */
function wsClose(socket: net.Socket, timeoutMs = 200): Promise<void> {
  return new Promise(resolve => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      socket.write(buildCloseFrame());
    } catch {
      // Socket may already be closing
    }
  });
}

// ── Port allocation (avoid collisions with other tests) ───────

const PORT_240 = 3940;
const PORT_241 = 3941;
const PORT_242 = 3942;
const PORT_007 = 3943;
const PORT_009 = 3944;
const PORT_010 = 3945;

// ── t-240: WebSocket handshake and framing ────────────────────

describe('Cowork bridge WebSocket handshake and framing (t-240)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;
  let client: net.Socket | null = null;

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_240);
    await bridge.start();
  });

  afterEach(async () => {
    if (client && !client.destroyed) client.destroy();
    client = null;
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  it('performs WebSocket upgrade on /cowork', async () => {
    client = await wsConnect(PORT_240, '/cowork');
    assert.ok(!client.destroyed, 'Socket should be open after upgrade');
  });

  it('sets session connected after handshake', async () => {
    client = await wsConnect(PORT_240, '/cowork');
    await sleep(20);
    assert.ok(isCoworkConnected(), 'Session should be marked connected');
  });

  it('ignores upgrade requests for other paths — session stays unset', async () => {
    // Connect a /cowork session first so we can confirm the state doesn't change
    // when a second client hits /other.
    client = await wsConnect(PORT_240, '/cowork');
    await sleep(20);
    assert.ok(isCoworkConnected(), 'Initial /cowork session should be connected');

    // Connect another socket to /other (NOT /cowork) — bridge should ignore it.
    // Because the HTTP server has no handler for this upgrade, the socket will
    // be left open by Node's http.Server.  We immediately destroy it.
    const otherSock = net.createConnection({ host: '127.0.0.1', port: PORT_240 }, () => {
      otherSock.write(
        'GET /other HTTP/1.1\r\n' +
        `Host: localhost:${PORT_240}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
      );
    });
    await sleep(50);
    otherSock.destroy();
    await sleep(20);

    // The /cowork session should still be alive (it was not touched by /other)
    assert.ok(isCoworkConnected(), 'Original /cowork session should still be connected');
  });

  it('receives hello message and updates userAgent', async () => {
    client = await wsConnect(PORT_240, '/cowork');
    await sleep(20);

    const hello = JSON.stringify({ type: 'hello', userAgent: 'TestBrowser/1.0' });
    client.write(buildTextFrame(hello));
    await sleep(30);

    const status = getCoworkStatus();
    assert.equal(status.connected, true);
    assert.equal(status.userAgent, 'TestBrowser/1.0');
  });

  it('session disconnected after client closes', async () => {
    client = await wsConnect(PORT_240, '/cowork');
    await sleep(20);
    assert.ok(isCoworkConnected());

    // Send a WebSocket close frame before destroying to trigger clean close event
    await wsClose(client, 100);
    client = null;
    await sleep(50);
    assert.ok(!isCoworkConnected(), 'Session should be gone after socket close');
  });

  it('new connection replaces existing session', async () => {
    const first = await wsConnect(PORT_240, '/cowork');
    await sleep(20);
    assert.ok(isCoworkConnected());

    const second = await wsConnect(PORT_240, '/cowork');
    await sleep(50);
    assert.ok(isCoworkConnected(), 'Session should still be active (new one)');

    first.destroy();
    second.destroy();
  });
});

// ── t-241: REST API routes ────────────────────────────────────

describe('Cowork bridge REST API routes (t-241)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_241);
    await bridge.start();
  });

  afterEach(async () => {
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  it('GET /api/cowork/status returns disconnected when no session', async () => {
    const { status, body } = await httpRequest(PORT_241, 'GET', '/api/cowork/status');
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['connected'], false);
  });

  it('GET /api/cowork/status returns connected after WebSocket join', async () => {
    const sock = await wsConnect(PORT_241, '/cowork');
    await sleep(30);

    const { status, body } = await httpRequest(PORT_241, 'GET', '/api/cowork/status');
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['connected'], true);
    assert.equal(typeof parsed['connectedAt'], 'string');
    assert.equal(typeof parsed['lastActivity'], 'string');

    sock.destroy();
  });

  it('GET /api/cowork/tabs returns 503 when no session', async () => {
    const { status, body } = await httpRequest(PORT_241, 'GET', '/api/cowork/tabs');
    assert.equal(status, 503);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(typeof parsed['error'], 'string');
  });

  it('POST /api/cowork/cdp returns 503 when no session', async () => {
    const { status, body } = await httpRequest(
      PORT_241, 'POST', '/api/cowork/cdp',
      JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '1+1' } }),
    );
    assert.equal(status, 503);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(typeof parsed['error'], 'string');
  });

  it('POST /api/cowork/cdp returns 400 when method missing', async () => {
    // Must have a session to reach the validation, so connect first
    const sock = await wsConnect(PORT_241, '/cowork');
    await sleep(20);

    const { status, body } = await httpRequest(
      PORT_241, 'POST', '/api/cowork/cdp',
      JSON.stringify({ params: {} }),
    );
    assert.equal(status, 400);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.ok(typeof parsed['error'] === 'string' && parsed['error'].includes('method'));

    sock.destroy();
  });

  it('handleCoworkRoute returns false for unmatched paths', async () => {
    // Direct call to the route handler
    const fakeReq = { method: 'GET' } as http.IncomingMessage;
    const fakeRes = {} as http.ServerResponse;
    const handled = await handleCoworkRoute(fakeReq, fakeRes, '/api/cowork/unknown', new URLSearchParams());
    assert.equal(handled, false);
  });
});

// ── t-242: Public API — sendCdpCommand, listTabs, switchTab ──

describe('Cowork bridge public API (t-242)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_242);
    await bridge.start();
  });

  afterEach(async () => {
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  it('sendCdpCommand rejects immediately when no session', async () => {
    await assert.rejects(
      () => sendCdpCommand('Runtime.evaluate', { expression: '1' }),
      (err: Error) => {
        assert.ok(err.message.includes('No cowork session'));
        return true;
      },
    );
  });

  it('listTabs rejects immediately when no session', async () => {
    await assert.rejects(
      () => listTabs(),
      (err: Error) => {
        assert.ok(err.message.includes('No cowork session'));
        return true;
      },
    );
  });

  it('switchTab rejects immediately when no session', async () => {
    await assert.rejects(
      () => switchTab(1),
      (err: Error) => {
        assert.ok(err.message.includes('No cowork session'));
        return true;
      },
    );
  });

  it('sendCdpCommand sends CDP frame and resolves when extension replies', async () => {
    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    // Start the CDP command — it will send a frame and await a reply
    const resultPromise = sendCdpCommand('Runtime.evaluate', { expression: '6*7' });

    // Read the frame the server sent us
    const frameText = await readServerFrame(sock, 1000);
    const msg = JSON.parse(frameText) as Record<string, unknown>;

    assert.equal(msg['type'], 'cdp');
    assert.equal(msg['method'], 'Runtime.evaluate');
    assert.ok(typeof msg['id'] === 'number');

    // Reply with a cdp-result
    const reply = JSON.stringify({
      type: 'cdp-result',
      id: msg['id'],
      result: { value: 42 },
    });
    sock.write(buildTextFrame(reply));

    const result = await resultPromise;
    assert.deepEqual(result, { value: 42 });

    sock.destroy();
  });

  it('sendCdpCommand rejects on cdp-error reply', async () => {
    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    const resultPromise = sendCdpCommand('Invalid.method', {});

    const frameText = await readServerFrame(sock, 1000);
    const msg = JSON.parse(frameText) as Record<string, unknown>;

    const errReply = JSON.stringify({
      type: 'cdp-error',
      id: msg['id'],
      error: { message: 'Method not found' },
    });
    sock.write(buildTextFrame(errReply));

    await assert.rejects(
      () => resultPromise,
      (err: Error) => {
        assert.ok(err.message.includes('Method not found'));
        return true;
      },
    );

    sock.destroy();
  });

  it('listTabs sends list-tabs frame and resolves with array', async () => {
    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    const tabsPromise = listTabs();
    const frameText = await readServerFrame(sock, 1000);
    const msg = JSON.parse(frameText) as Record<string, unknown>;

    assert.equal(msg['type'], 'list-tabs');
    assert.ok(typeof msg['id'] === 'number');

    const tabList = [{ id: 1, title: 'Home', url: 'https://example.com' }];
    sock.write(buildTextFrame(JSON.stringify({
      type: 'tab-list',
      id: msg['id'],
      tabs: tabList,
    })));

    const tabs = await tabsPromise;
    assert.deepEqual(tabs, tabList);

    sock.destroy();
  });

  it('switchTab sends switch-tab frame and resolves with tabId', async () => {
    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    const switchPromise = switchTab(5);
    const frameText = await readServerFrame(sock, 1000);
    const msg = JSON.parse(frameText) as Record<string, unknown>;

    assert.equal(msg['type'], 'switch-tab');
    assert.equal(msg['tabId'], 5);

    sock.write(buildTextFrame(JSON.stringify({
      type: 'tab-switched',
      id: msg['id'],
      tabId: 5,
    })));

    const result = await switchPromise as Record<string, unknown>;
    assert.equal(result['tabId'], 5);

    sock.destroy();
  });

  it('pending commands rejected on shutdown', async () => {
    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    // Start a command that we will NOT reply to
    const resultPromise = sendCdpCommand('Page.navigate', { url: 'https://example.com' });

    // Consume the frame so the socket doesn't back up
    await readServerFrame(sock, 500).catch(() => { /* timing, ignore */ });

    // Shut down — all pending commands should be rejected
    shutdownCoworkBridge();

    await assert.rejects(
      () => resultPromise,
      (err: Error) => {
        assert.ok(
          err.message.includes('Shutdown') || err.message.includes('closed') || err.message.includes('replaced'),
          `Unexpected error: ${err.message}`,
        );
        return true;
      },
    );

    sock.destroy();
  });

  it('getCoworkStatus reflects live session info', async () => {
    assert.equal(getCoworkStatus().connected, false);

    const sock = await wsConnect(PORT_242, '/cowork');
    await sleep(20);

    const status = getCoworkStatus();
    assert.equal(status.connected, true);
    assert.ok(typeof status.connectedAt === 'string');
    assert.ok(typeof status.lastActivity === 'string');

    // Send a WebSocket close frame so the server clears the session cleanly
    await wsClose(sock, 100);
    await sleep(50);

    assert.equal(getCoworkStatus().connected, false);
  });
});

// ── t-007: Cowork bridge key exchange ────────────────────────

/**
 * Helper to perform a complete key exchange as the "extension" side.
 * Returns { sock, sessionKey } where sessionKey is the derived AES key.
 */
async function performKeyExchange(
  port: number,
  psk: string,
): Promise<{ sock: net.Socket; sessionKey: Buffer; extKeyPair: ReturnType<typeof generateEphemeralKeyPair> }> {
  const sock = await wsConnect(port, '/cowork');
  await sleep(20);

  // Generate extension ephemeral keypair
  const extKeyPair = generateEphemeralKeyPair();

  // Send key-exchange
  sock.write(buildTextFrame(JSON.stringify({
    type: 'key-exchange',
    publicKey: extKeyPair.publicKeyB64,
  })));

  // Read daemon's key-exchange response
  const responseText = await readServerFrame(sock, 2000);
  const response = JSON.parse(responseText) as Record<string, unknown>;
  assert.equal(response['type'], 'key-exchange');
  assert.equal(typeof response['publicKey'], 'string');

  const daemonPubKeyB64 = response['publicKey'] as string;

  // Compute shared secret and derive session key
  const sharedSecret = computeSharedSecret(extKeyPair.privateKey, daemonPubKeyB64);
  const sessionKey = deriveSessionKey(sharedSecret, psk, extKeyPair.publicKeyB64, daemonPubKeyB64);

  return { sock, sessionKey, extKeyPair };
}

describe('Cowork bridge key exchange (t-007)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;
  const TEST_PSK = 'a'.repeat(64); // 64 hex chars = 256-bit PSK

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_007);
    await bridge.start();
  });

  afterEach(async () => {
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  it('key exchange succeeds with valid PSK', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await performKeyExchange(PORT_007, TEST_PSK);

    // Send encrypted hello
    const helloEnvelope = encryptEnvelope(sessionKey, { type: 'hello', userAgent: 'Test/1.0' }, 1);
    sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));

    // Read encrypted hello-ack
    const ackText = await readServerFrame(sock, 2000);
    const ackEnvelope = JSON.parse(ackText) as EncryptedEnvelope;
    assert.equal(ackEnvelope.type, 'encrypted');
    assert.equal(ackEnvelope.seq, 1);

    const ack = decryptEnvelope(sessionKey, ackEnvelope) as Record<string, unknown>;
    assert.equal(ack['type'], 'hello-ack');

    sock.destroy();
  });

  it('key exchange fails without PSK configured', async () => {
    // No PSK set — key exchange should fail with close code 4001
    const sock = await wsConnect(PORT_007, '/cowork');
    await sleep(20);

    const extKeyPair = generateEphemeralKeyPair();
    sock.write(buildTextFrame(JSON.stringify({
      type: 'key-exchange',
      publicKey: extKeyPair.publicKeyB64,
    })));

    // Server should close with code 4001
    const closeReceived = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 2000);
      const onData = (chunk: Buffer) => {
        // Look for a close frame (opcode 0x08)
        if (chunk.length >= 2 && (chunk[0] & 0x0f) === 0x08) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          // Parse close code from bytes 2-3 of the payload
          const code = chunk.length >= 4 ? chunk.readUInt16BE(2) : 0;
          resolve(code === 4001);
        }
      };
      sock.on('data', onData);
      sock.on('close', () => { clearTimeout(timer); resolve(true); });
    });

    assert.ok(closeReceived, 'Server should close connection when no PSK configured');
    if (!sock.destroyed) sock.destroy();
  });

  it('encrypted hello roundtrip works', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await performKeyExchange(PORT_007, TEST_PSK);

    // Send encrypted hello with userAgent
    const helloEnvelope = encryptEnvelope(sessionKey, {
      type: 'hello',
      userAgent: 'CoworkExtension/2.0',
    }, 1);
    sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));

    // Read encrypted hello-ack
    const ackText = await readServerFrame(sock, 2000);
    const ackEnvelope = JSON.parse(ackText) as EncryptedEnvelope;
    assert.equal(ackEnvelope.type, 'encrypted');

    const ack = decryptEnvelope(sessionKey, ackEnvelope) as Record<string, unknown>;
    assert.equal(ack['type'], 'hello-ack');

    // Verify session is connected and has userAgent
    await sleep(20);
    const status = getCoworkStatus();
    assert.equal(status.connected, true);
    assert.equal(status.userAgent, 'CoworkExtension/2.0');

    sock.destroy();
  });

  it('wrong PSK causes decryption failure at hello', async () => {
    const correctPsk = TEST_PSK;
    const wrongPsk = 'b'.repeat(64);
    setPsk(correctPsk);

    // Perform key exchange with correct PSK on wire (daemon side) but derive
    // session key with wrong PSK on extension side
    const sock = await wsConnect(PORT_007, '/cowork');
    await sleep(20);

    const extKeyPair = generateEphemeralKeyPair();
    sock.write(buildTextFrame(JSON.stringify({
      type: 'key-exchange',
      publicKey: extKeyPair.publicKeyB64,
    })));

    const responseText = await readServerFrame(sock, 2000);
    const response = JSON.parse(responseText) as Record<string, unknown>;
    const daemonPubKeyB64 = response['publicKey'] as string;

    // Derive session key with WRONG PSK
    const sharedSecret = computeSharedSecret(extKeyPair.privateKey, daemonPubKeyB64);
    const wrongSessionKey = deriveSessionKey(sharedSecret, wrongPsk, extKeyPair.publicKeyB64, daemonPubKeyB64);

    // Send hello encrypted with wrong key
    const helloEnvelope = encryptEnvelope(wrongSessionKey, { type: 'hello', userAgent: 'Test' }, 1);
    sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));

    // Server should close with 4002 (decryption failed)
    const closeCode = await new Promise<number>(resolve => {
      const timer = setTimeout(() => resolve(0), 2000);
      const onData = (chunk: Buffer) => {
        if (chunk.length >= 4 && (chunk[0] & 0x0f) === 0x08) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(chunk.readUInt16BE(2));
        }
      };
      sock.on('data', onData);
      sock.on('close', () => { clearTimeout(timer); resolve(0); });
    });

    assert.equal(closeCode, 4002, 'Server should close with 4002 on decryption failure');
    if (!sock.destroyed) sock.destroy();
  });

  it('sequence violation causes close with 4003', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await performKeyExchange(PORT_007, TEST_PSK);

    // Send encrypted hello (seq=1)
    const helloEnvelope = encryptEnvelope(sessionKey, { type: 'hello', userAgent: 'Test' }, 1);
    sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));

    // Read hello-ack
    const ackText = await readServerFrame(sock, 2000);
    const ackEnvelope = JSON.parse(ackText) as EncryptedEnvelope;
    assert.equal(ackEnvelope.type, 'encrypted');
    const ack = decryptEnvelope(sessionKey, ackEnvelope) as Record<string, unknown>;
    assert.equal(ack['type'], 'hello-ack');

    // Now send a message with wrong seq (gap: should be 2, sending 5)
    const badSeqEnvelope = encryptEnvelope(sessionKey, { type: 'hello' }, 5);
    sock.write(buildTextFrame(JSON.stringify(badSeqEnvelope)));

    // Server should close with 4003
    const closeCode = await new Promise<number>(resolve => {
      const timer = setTimeout(() => resolve(0), 2000);
      const onData = (chunk: Buffer) => {
        if (chunk.length >= 4 && (chunk[0] & 0x0f) === 0x08) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(chunk.readUInt16BE(2));
        }
      };
      sock.on('data', onData);
      sock.on('close', () => { clearTimeout(timer); resolve(0); });
    });

    assert.equal(closeCode, 4003, 'Server should close with 4003 on sequence violation');
    if (!sock.destroyed) sock.destroy();
  });

  it('GET /api/cowork/fingerprint returns 404 when no session', async () => {
    const { status } = await httpRequest(PORT_007, 'GET', '/api/cowork/fingerprint');
    assert.equal(status, 404);
  });

  it('GET /api/cowork/fingerprint returns fingerprint after key exchange', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await performKeyExchange(PORT_007, TEST_PSK);

    // Send hello to complete key exchange
    const helloEnvelope = encryptEnvelope(sessionKey, { type: 'hello', userAgent: 'Test' }, 1);
    sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));
    await readServerFrame(sock, 2000); // read hello-ack
    await sleep(20);

    const { status, body } = await httpRequest(PORT_007, 'GET', '/api/cowork/fingerprint');
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(typeof parsed['fingerprint'], 'string');
    assert.match(parsed['fingerprint'] as string, /^[0-9a-f]{16}$/);

    sock.destroy();
  });
});

// ── t-009: Encrypted CDP roundtrip ───────────────────────────

/**
 * Helper to establish a fully encrypted session (key exchange + hello/hello-ack).
 * Returns { sock, sessionKey, recvSeq } where recvSeq=1 (after hello-ack).
 */
async function establishEncryptedSession(
  port: number,
  psk: string,
): Promise<{ sock: net.Socket; sessionKey: Buffer; sendSeq: number; recvSeq: number }> {
  const { sock, sessionKey } = await performKeyExchange(port, psk);

  // Send encrypted hello (seq=1)
  const helloEnvelope = encryptEnvelope(sessionKey, { type: 'hello', userAgent: 'Test/1.0' }, 1);
  sock.write(buildTextFrame(JSON.stringify(helloEnvelope)));

  // Read encrypted hello-ack
  const ackText = await readServerFrame(sock, 2000);
  const ackEnvelope = JSON.parse(ackText) as EncryptedEnvelope;
  assert.equal(ackEnvelope.type, 'encrypted');
  assert.equal(ackEnvelope.seq, 1);
  const ack = decryptEnvelope(sessionKey, ackEnvelope) as Record<string, unknown>;
  assert.equal(ack['type'], 'hello-ack');

  // At this point: extension sendSeq=1, recvSeq=1; daemon sendSeq=1, recvSeq=1
  return { sock, sessionKey, sendSeq: 1, recvSeq: 1 };
}

describe('Encrypted CDP roundtrip (t-009)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;
  const TEST_PSK = 'c'.repeat(64); // 64 hex chars = 256-bit PSK

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_009);
    await bridge.start();
  });

  afterEach(async () => {
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  it('sendCdpCommand sends encrypted CDP frame and resolves when extension replies encrypted', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey, recvSeq: initialRecvSeq } = await establishEncryptedSession(PORT_009, TEST_PSK);

    // Track client-side sequence counters
    let clientSendSeq = 1; // sent hello (seq=1)
    let clientRecvSeq = initialRecvSeq; // received hello-ack (seq=1)

    // Start CDP command from daemon side — it will send an encrypted frame
    const resultPromise = sendCdpCommand('Runtime.evaluate', { expression: '6*7' });

    // Read the encrypted frame the daemon sent
    const frameText = await readServerFrame(sock, 1000);
    const envelope = JSON.parse(frameText) as EncryptedEnvelope;

    // Verify it's encrypted
    assert.equal(envelope.type, 'encrypted');
    clientRecvSeq += 1;
    assert.equal(envelope.seq, clientRecvSeq, 'CDP command should have incremented daemon sendSeq');

    // Decrypt and verify inner message
    const inner = decryptEnvelope(sessionKey, envelope) as Record<string, unknown>;
    assert.equal(inner['type'], 'cdp');
    assert.equal(inner['method'], 'Runtime.evaluate');
    assert.ok(typeof inner['id'] === 'number', 'CDP command should have a numeric id');
    const cmdId = inner['id'] as number;

    // Send encrypted CDP result back
    clientSendSeq += 1;
    const replyEnvelope = encryptEnvelope(sessionKey, {
      type: 'cdp-result',
      id: cmdId,
      result: { value: 42 },
    }, clientSendSeq);
    sock.write(buildTextFrame(JSON.stringify(replyEnvelope)));

    // Verify daemon resolves the promise with correct result
    const result = await resultPromise;
    assert.deepEqual(result, { value: 42 });

    // Verify sequence counters incremented correctly:
    // Daemon recvSeq should now be 2 (hello=1, cdp-result=2)
    // Daemon sendSeq should be 2 (hello-ack=1, cdp=2)
    // We verify indirectly: send another command and check seq increments
    const resultPromise2 = sendCdpCommand('Page.reload', {});
    const frameText2 = await readServerFrame(sock, 1000);
    const envelope2 = JSON.parse(frameText2) as EncryptedEnvelope;
    assert.equal(envelope2.type, 'encrypted');
    assert.equal(envelope2.seq, clientRecvSeq + 1, 'Second CDP command seq should be 3');

    const inner2 = decryptEnvelope(sessionKey, envelope2) as Record<string, unknown>;
    assert.equal(inner2['type'], 'cdp');
    const cmdId2 = inner2['id'] as number;

    clientSendSeq += 1;
    const replyEnvelope2 = encryptEnvelope(sessionKey, {
      type: 'cdp-result',
      id: cmdId2,
      result: { reloaded: true },
    }, clientSendSeq);
    sock.write(buildTextFrame(JSON.stringify(replyEnvelope2)));

    const result2 = await resultPromise2;
    assert.deepEqual(result2, { reloaded: true });

    sock.destroy();
  });

  it('listTabs over encrypted session resolves with tab array', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await establishEncryptedSession(PORT_009, TEST_PSK);
    let clientSendSeq = 1;
    let clientRecvSeq = 1;

    const tabsPromise = listTabs();

    // Read encrypted list-tabs frame
    const frameText = await readServerFrame(sock, 1000);
    const envelope = JSON.parse(frameText) as EncryptedEnvelope;
    assert.equal(envelope.type, 'encrypted');
    clientRecvSeq += 1;
    assert.equal(envelope.seq, clientRecvSeq);

    const inner = decryptEnvelope(sessionKey, envelope) as Record<string, unknown>;
    assert.equal(inner['type'], 'list-tabs');
    assert.ok(typeof inner['id'] === 'number');
    const cmdId = inner['id'] as number;

    // Reply with encrypted tab-list
    const tabList = [{ tabId: 1, title: 'Home', url: 'https://example.com', active: true, windowId: 1 }];
    clientSendSeq += 1;
    const replyEnvelope = encryptEnvelope(sessionKey, {
      type: 'tab-list',
      id: cmdId,
      tabs: tabList,
    }, clientSendSeq);
    sock.write(buildTextFrame(JSON.stringify(replyEnvelope)));

    const tabs = await tabsPromise;
    assert.deepEqual(tabs, tabList);

    sock.destroy();
  });
});

// ── t-010: Sequence violation and tamper detection ────────────

describe('Sequence violation and tamper detection (t-010)', () => {
  let bridge: ReturnType<typeof createBridgeServer>;
  const TEST_PSK = 'd'.repeat(64); // 64 hex chars = 256-bit PSK

  beforeEach(async () => {
    _resetCoworkBridgeForTesting();
    bridge = createBridgeServer(PORT_010);
    await bridge.start();
  });

  afterEach(async () => {
    shutdownCoworkBridge();
    await bridge.stop();
    _resetCoworkBridgeForTesting();
    await sleep(20);
  });

  /** Wait for a close frame and return its code. */
  function waitForCloseCode(socket: net.Socket, timeoutMs = 2000): Promise<number> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(0), timeoutMs);
      const onData = (chunk: Buffer) => {
        if (chunk.length >= 4 && (chunk[0] & 0x0f) === 0x08) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve(chunk.readUInt16BE(2));
        }
      };
      socket.on('data', onData);
      socket.on('close', () => { clearTimeout(timer); resolve(0); });
    });
  }

  it('replay attack (seq=2 twice after hello) causes close with 4003', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await establishEncryptedSession(PORT_010, TEST_PSK);

    // Send correct seq=2
    const msg2 = encryptEnvelope(sessionKey, { type: 'pong' }, 2);
    sock.write(buildTextFrame(JSON.stringify(msg2)));

    // Give daemon time to process seq=2
    await sleep(30);

    // Send seq=2 again — replay attack
    const msg2Replay = encryptEnvelope(sessionKey, { type: 'pong' }, 2);
    sock.write(buildTextFrame(JSON.stringify(msg2Replay)));

    const closeCode = await waitForCloseCode(sock);
    assert.equal(closeCode, 4003, 'Replay (seq=2 again) should close with 4003');
    if (!sock.destroyed) sock.destroy();
  });

  it('sequence gap (seq=2 then seq=5) causes close with 4003', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await establishEncryptedSession(PORT_010, TEST_PSK);

    // Send correct seq=2
    const msg2 = encryptEnvelope(sessionKey, { type: 'pong' }, 2);
    sock.write(buildTextFrame(JSON.stringify(msg2)));
    await sleep(30);

    // Send seq=5 — gap skips 3 and 4
    const msg5 = encryptEnvelope(sessionKey, { type: 'pong' }, 5);
    sock.write(buildTextFrame(JSON.stringify(msg5)));

    const closeCode = await waitForCloseCode(sock);
    assert.equal(closeCode, 4003, 'Sequence gap should close with 4003');
    if (!sock.destroyed) sock.destroy();
  });

  it('tampered ciphertext causes close with 4002', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await establishEncryptedSession(PORT_010, TEST_PSK);

    // Build a valid encrypted envelope for seq=2
    const validEnvelope = encryptEnvelope(sessionKey, { type: 'pong' }, 2);

    // Tamper: flip a byte in the middle of the payload
    const payloadBytes = Buffer.from(validEnvelope.payload, 'base64');
    const midPoint = Math.floor(payloadBytes.length / 2);
    payloadBytes[midPoint] ^= 0xff;
    const tamperedEnvelope = {
      ...validEnvelope,
      payload: payloadBytes.toString('base64'),
    };

    sock.write(buildTextFrame(JSON.stringify(tamperedEnvelope)));

    const closeCode = await waitForCloseCode(sock);
    assert.equal(closeCode, 4002, 'Tampered ciphertext should close with 4002');
    if (!sock.destroyed) sock.destroy();
  });

  it('CDP roundtrip with correct seqs accepted after hello in encrypted session', async () => {
    setPsk(TEST_PSK);

    const { sock, sessionKey } = await establishEncryptedSession(PORT_010, TEST_PSK);
    let clientSendSeq = 1;
    let clientRecvSeq = 1;

    // Start CDP command
    const resultPromise = sendCdpCommand('DOM.getDocument', {});

    const frameText = await readServerFrame(sock, 1000);
    const envelope = JSON.parse(frameText) as EncryptedEnvelope;
    assert.equal(envelope.type, 'encrypted');
    clientRecvSeq += 1;
    assert.equal(envelope.seq, clientRecvSeq);

    const inner = decryptEnvelope(sessionKey, envelope) as Record<string, unknown>;
    assert.equal(inner['type'], 'cdp');
    const cmdId = inner['id'] as number;

    // Send valid encrypted reply with next seq
    clientSendSeq += 1;
    const replyEnvelope = encryptEnvelope(sessionKey, {
      type: 'cdp-result',
      id: cmdId,
      result: { root: { nodeId: 1 } },
    }, clientSendSeq);
    sock.write(buildTextFrame(JSON.stringify(replyEnvelope)));

    const result = await resultPromise as Record<string, unknown>;
    assert.deepEqual(result, { root: { nodeId: 1 } });

    sock.destroy();
  });
});
