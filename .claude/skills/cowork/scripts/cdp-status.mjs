#!/usr/bin/env node
/**
 * Check Chrome CDP status and list open tabs.
 * Uses only Node.js built-ins.
 *
 * Usage: node cdp-status.mjs [host] [port]
 */
import http from 'node:http';

const HOST = process.argv[2] || 'localhost';
const PORT = parseInt(process.argv[3] || '9223');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

async function main() {
  // Check version endpoint
  try {
    const raw = await httpGet(`http://${HOST}:${PORT}/json/version`);
    const version = JSON.parse(raw);
    console.log(`Connected to Chrome at ${HOST}:${PORT}`);
    console.log(`  Browser: ${version.Browser || 'unknown'}`);
    console.log(`  Protocol: ${version['Protocol-Version'] || 'unknown'}`);
  } catch (e) {
    console.error(`UNREACHABLE: Cannot connect to Chrome at ${HOST}:${PORT}`);
    console.error(`  Error: ${e.message}`);
    console.error('');
    console.error('Dave needs to launch Chrome with remote debugging:');
    console.error('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\');
    console.error('    --remote-debugging-port=9222 \\');
    console.error('    --user-data-dir=/tmp/chrome-cowork \\');
    console.error('    --no-first-run --no-default-browser-check');
    console.error('');
    console.error('Then BMO sets up the SSH tunnel:');
    console.error('  ssh -f -N -L 9223:localhost:9222 davidhurley@192.168.12.151');
    process.exit(1);
  }

  // List tabs
  try {
    const raw = await httpGet(`http://${HOST}:${PORT}/json/list`);
    const tabs = JSON.parse(raw);
    const pages = tabs.filter(t => t.type === 'page');
    console.log(`\n${pages.length} page tab(s) open (${tabs.length} total):`);
    for (let i = 0; i < pages.length; i++) {
      const tab = pages[i];
      const title = (tab.title || 'untitled').slice(0, 60);
      const url = (tab.url || '').slice(0, 80);
      const hasWs = 'webSocketDebuggerUrl' in tab;
      console.log(`  [${i}] ${hasWs ? 'OK' : 'NO-WS'} ${title}`);
      console.log(`      ${url}`);
    }
  } catch (e) {
    console.error(`\nCould not list tabs: ${e.message}`);
  }
}

main();
