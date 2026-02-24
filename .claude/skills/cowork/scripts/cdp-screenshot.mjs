#!/usr/bin/env node
/**
 * Take a screenshot of a Chrome tab via CDP WebSocket.
 * Uses only Node.js built-ins (WebSocket available in Node 22+).
 *
 * Usage: node cdp-screenshot.mjs [host] [port] [output_path] [tab_index]
 */
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const HOST = process.argv[2] || 'localhost';
const PORT = parseInt(process.argv[3] || '9223');
const OUTPUT = process.argv[4] || 'cowork-screenshot.png';
const TAB_INDEX = parseInt(process.argv[5] || '0');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  // Get tab list
  let tabs;
  try {
    const raw = await httpGet(`http://${HOST}:${PORT}/json/list`);
    tabs = JSON.parse(raw);
  } catch (e) {
    console.error(`ERROR: Cannot reach Chrome at ${HOST}:${PORT} — ${e.message}`);
    process.exit(1);
  }

  // Filter to page tabs only
  const pages = tabs.filter(t => t.type === 'page');
  if (pages.length === 0) {
    console.error('ERROR: No page tabs open in Chrome');
    process.exit(1);
  }

  const idx = Math.min(TAB_INDEX, pages.length - 1);
  const tab = pages[idx];
  let wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.error(`ERROR: Tab "${tab.title}" has no WebSocket URL`);
    process.exit(1);
  }

  // When tunneled, Chrome's localhost WS URLs are already correct
  // For non-tunnel usage, fix host in WebSocket URL
  if (HOST !== 'localhost' && HOST !== '127.0.0.1') {
    wsUrl = wsUrl.replace(/localhost|127\.0\.0\.1/g, HOST);
  }

  console.log(`Tab: ${tab.title.slice(0, 60)}`);
  console.log(`URL: ${tab.url.slice(0, 80)}`);

  // Connect via WebSocket
  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    let timer;

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot' }));
    };

    ws.onmessage = (event) => {
      const resp = JSON.parse(event.data);
      if (resp.error) {
        clearTimeout(timer);
        console.error(`ERROR: CDP error — ${JSON.stringify(resp.error)}`);
        ws.close();
        process.exit(1);
      }
      if (resp.id === 1 && resp.result?.data) {
        clearTimeout(timer);
        const buf = Buffer.from(resp.result.data, 'base64');
        writeFileSync(OUTPUT, buf);
        console.log(`Screenshot saved: ${OUTPUT} (${buf.length.toLocaleString()} bytes)`);
        ws.close();
        resolve();
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      console.error(`WebSocket error: ${err.message || err}`);
      reject(err);
    };

    timer = setTimeout(() => {
      console.error('ERROR: Timeout waiting for screenshot');
      ws.close();
      process.exit(1);
    }, 10000);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
