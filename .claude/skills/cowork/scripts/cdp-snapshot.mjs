#!/usr/bin/env node
/**
 * Get an accessibility snapshot or page content from a Chrome tab via CDP.
 * Uses only Node.js built-ins (WebSocket available in Node 22+).
 *
 * Usage: node cdp-snapshot.mjs [host] [port] [tab_index]
 */
import http from 'node:http';

const HOST = process.argv[2] || 'localhost';
const PORT = parseInt(process.argv[3] || '9223');
const TAB_INDEX = parseInt(process.argv[4] || '0');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

let msgId = 0;
function sendCDP(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    const handler = (event) => {
      const resp = JSON.parse(event.data);
      if (resp.id === id) {
        ws.removeEventListener('message', handler);
        resolve(resp);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  let tabs;
  try {
    const raw = await httpGet(`http://${HOST}:${PORT}/json/list`);
    tabs = JSON.parse(raw);
  } catch (e) {
    console.error(`ERROR: Cannot reach Chrome at ${HOST}:${PORT} — ${e.message}`);
    process.exit(1);
  }

  const pages = tabs.filter(t => t.type === 'page');
  if (pages.length === 0) {
    console.error('ERROR: No page tabs open in Chrome');
    process.exit(1);
  }

  const idx = Math.min(TAB_INDEX, pages.length - 1);
  const tab = pages[idx];
  let wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.error('ERROR: Tab has no WebSocket URL');
    process.exit(1);
  }
  // When tunneled, Chrome's localhost WS URLs are already correct
  // For non-tunnel usage, fix host in WebSocket URL
  if (HOST !== 'localhost' && HOST !== '127.0.0.1') {
    wsUrl = wsUrl.replace(/localhost|127\.0\.0\.1/g, HOST);
  }

  console.log(`Tab: ${tab.title.slice(0, 80)}`);
  console.log(`URL: ${tab.url.slice(0, 100)}`);
  console.log('---');

  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    let timer;

    ws.onopen = async () => {
      try {
        // Get page title
        const titleResp = await sendCDP(ws, 'Runtime.evaluate', {
          expression: 'document.title'
        });
        const title = titleResp.result?.result?.value || 'unknown';
        console.log(`Page: ${title}`);
        console.log('');

        // Try accessibility tree first
        await sendCDP(ws, 'Accessibility.enable');
        const axResp = await sendCDP(ws, 'Accessibility.getFullAXTree');

        if (axResp.error) {
          // Fallback to DOM content extraction
          console.log('Accessibility API unavailable, using DOM extraction...');
          console.log('');
          const domResp = await sendCDP(ws, 'Runtime.evaluate', {
            expression: `(function() {
              const els = document.querySelectorAll('h1,h2,h3,h4,a,button,input,textarea,select,p,li,td,th,label,img');
              return Array.from(els).slice(0, 100).map(el => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').trim().slice(0, 120);
                const href = el.href || '';
                const type = el.type || '';
                const alt = el.alt || '';
                let desc = '[' + tag + ']';
                if (type) desc += ' type=' + type;
                if (text) desc += ' "' + text.replace(/\\n/g, ' ').replace(/\\s+/g, ' ') + '"';
                if (alt) desc += ' alt="' + alt + '"';
                if (href) desc += ' → ' + href.slice(0, 80);
                return desc;
              }).join('\\n');
            })()`
          });
          console.log(domResp.result?.result?.value || 'No content extracted');
        } else {
          const nodes = axResp.result?.nodes || [];
          console.log(`Accessibility nodes: ${nodes.length}`);
          console.log('');

          // Build depth map
          const depthMap = {};
          for (const node of nodes) {
            const parentId = node.parentId;
            depthMap[node.nodeId] = parentId && depthMap[parentId] != null
              ? depthMap[parentId] + 1
              : 0;

            const role = node.role?.value || '';
            const name = node.name?.value || '';
            const value = node.value?.value || '';

            if (['none', 'generic', 'InlineTextBox', 'LineBreak'].includes(role)) continue;
            if (!name && !value) continue;

            const indent = '  '.repeat(Math.min(depthMap[node.nodeId], 10));
            let line = `${indent}[${role}]`;
            if (name) line += ` "${name.slice(0, 80)}"`;
            if (value) line += ` value=${value.slice(0, 60)}`;
            console.log(line);
          }

          await sendCDP(ws, 'Accessibility.disable');
        }

        clearTimeout(timer);
        ws.close();
        resolve();
      } catch (err) {
        clearTimeout(timer);
        console.error(`Error: ${err.message}`);
        ws.close();
        process.exit(1);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      console.error(`WebSocket error: ${err.message || err}`);
      reject(err);
    };

    timer = setTimeout(() => {
      console.error('ERROR: Timeout');
      ws.close();
      process.exit(1);
    }, 15000);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
