#!/usr/bin/env node
// Extracts failing-test identifiers from Node.js test runner JUnit XML output.
//
// Why JUnit and not the TAP/spec output: node --test's TAP output emits a
// "not ok" line for every nesting level (leaf test AND each parent describe/
// suite it bubbles up through), which is exactly the source of the
// 57 vs 81 vs 147 count discrepancies documented in
// .kithkit/reports/ci-gating-failure-triage-2026-06-05.md (todo #1873).
// The JUnit reporter flattens subtests into individual <testcase> elements
// with no parent-bubble duplication, giving us a clean leaf-level failure
// name for each actual failing test.
//
// Note: this is a small hand-rolled tag scanner, not a naive regex sweep —
// attribute values (e.g. failure="1 !== 2, 5 > 3 ...") legally contain
// unescaped '>' characters per the XML spec (only '<', '&', and the
// delimiting quote must be escaped inside an attribute value). A regex like
// /<testcase\b([^>]*?)>/ breaks the moment an assertion message contains a
// bare '>', truncating the attrs capture mid-value and losing name/file for
// that testcase. We track quote state explicitly to find the tag's real
// closing '>'.
//
// Usage: node list-test-failures.mjs <label> <junit-xml-file> [<junit-xml-file> ...]
// Prints one "<label>::<file-basename>::<test-name>" per line (sorted,
// deduped) to stdout. <label> namespaces failures per test-suite (daemon/cli)
// so identically-named tests in different packages/files don't collide.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

// Finds the index of the '>' that closes the opening tag starting at
// `start` (which must point at '<'), correctly skipping '>' characters that
// appear inside double-quoted attribute values.
function findTagEnd(xml, start) {
  let inQuote = false;
  for (let i = start; i < xml.length; i++) {
    const c = xml[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === '>' && !inQuote) return i;
  }
  return -1;
}

function extractFailures(xml) {
  const ids = [];
  let searchFrom = 0;
  for (;;) {
    const tagStart = xml.indexOf('<testcase', searchFrom);
    if (tagStart === -1) break;
    const tagEnd = findTagEnd(xml, tagStart);
    if (tagEnd === -1) break; // malformed — nothing more we can do
    const openTag = xml.slice(tagStart, tagEnd + 1);
    const selfClosing = openTag.endsWith('/>');

    if (selfClosing) {
      // Self-closing <testcase .../> is a pass/skip — no <failure> possible.
      searchFrom = tagEnd + 1;
      continue;
    }

    const closeTagIdx = xml.indexOf('</testcase>', tagEnd + 1);
    const bodyEnd = closeTagIdx === -1 ? xml.length : closeTagIdx;
    const body = xml.slice(tagEnd + 1, bodyEnd);

    if (/<failure\b/.test(body)) {
      const nameMatch = /\bname="([^"]*)"/.exec(openTag);
      const fileMatch = /\bfile="([^"]*)"/.exec(openTag);
      const name = nameMatch ? unescapeXml(nameMatch[1]) : '(unnamed)';
      const file = fileMatch ? basename(fileMatch[1]) : '(unknown-file)';
      ids.push(`${file}::${name}`);
    }

    searchFrom = closeTagIdx === -1 ? xml.length : closeTagIdx + '</testcase>'.length;
  }
  return ids;
}

const [label, ...xmlPaths] = process.argv.slice(2);
if (!label || xmlPaths.length === 0) {
  console.error('Usage: list-test-failures.mjs <label> <junit-xml-file> [<junit-xml-file> ...]');
  process.exit(2);
}

const ids = new Set();
for (const p of xmlPaths) {
  let xml;
  try {
    xml = readFileSync(p, 'utf8');
  } catch (err) {
    console.error(`list-test-failures: warning: could not read ${p}: ${err.message}`);
    continue;
  }
  for (const id of extractFailures(xml)) {
    ids.add(`${label}::${id}`);
  }
}

for (const id of [...ids].sort()) {
  console.log(id);
}
