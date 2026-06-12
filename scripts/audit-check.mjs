#!/usr/bin/env node
/**
 * audit-check.mjs — npm audit wrapper with CVE/GHSA allowlist support.
 *
 * Runs `npm audit --json`, cross-references the result against audit-allowlist.json,
 * and exits non-zero if any advisory is either:
 *   (a) not present in the allowlist, or
 *   (b) present but the allowlist entry is expired.
 *
 * Logs every suppressed advisory (id + reason + expiry) to stdout.
 *
 * Exit codes:
 *   0 — all advisories accounted for by a valid (non-expired) allowlist entry
 *   1 — at least one non-allowlisted or expired-entry advisory found
 *
 * Injectable environment variables (for testing — do not use in production):
 *   KKIT_AUDIT_JSON_FILE    Path to a JSON file to use instead of running npm audit.
 *   KKIT_AUDIT_ALLOWLIST    Path to the allowlist JSON (default: audit-allowlist.json at repo root).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Configuration ──────────────────────────────────────────────────────────

const ALLOWLIST_PATH =
  process.env.KKIT_AUDIT_ALLOWLIST ??
  path.join(REPO_ROOT, 'audit-allowlist.json');

const AUDIT_JSON_FILE = process.env.KKIT_AUDIT_JSON_FILE ?? null;

// ── Load allowlist ─────────────────────────────────────────────────────────

let allowlistDoc;
try {
  allowlistDoc = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
} catch (err) {
  process.stderr.write(
    `[audit-check] ERROR: Cannot read allowlist at ${ALLOWLIST_PATH}: ${err.message}\n`,
  );
  process.exit(1);
}

const rawEntries = allowlistDoc.allowlist ?? [];

// Validate and index entries by normalised id.
/** @type {Map<string, {id: string, expires: string, reason: string}>} */
const allowedById = new Map();
for (const entry of rawEntries) {
  if (!entry.id || !entry.expires || !entry.reason) {
    process.stderr.write(
      `[audit-check] ERROR: Allowlist entry is missing required fields (id, expires, reason):\n  ${JSON.stringify(entry)}\n`,
    );
    process.exit(1);
  }
  allowedById.set(entry.id.toUpperCase(), entry);
}

// ── Load audit data ────────────────────────────────────────────────────────

let auditJson;
if (AUDIT_JSON_FILE) {
  try {
    auditJson = JSON.parse(readFileSync(AUDIT_JSON_FILE, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `[audit-check] ERROR: Cannot read injected audit JSON file ${AUDIT_JSON_FILE}: ${err.message}\n`,
    );
    process.exit(1);
  }
} else {
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    shell: false,
  });
  try {
    auditJson = JSON.parse(result.stdout);
  } catch (err) {
    process.stderr.write(
      `[audit-check] ERROR: npm audit produced non-JSON output: ${err.message}\n` +
        `  stdout: ${result.stdout.slice(0, 500)}\n`,
    );
    process.exit(1);
  }
}

// ── Extract advisories from audit JSON ────────────────────────────────────

/**
 * Returns a deduplicated list of {id, title} objects from npm audit output.
 * Supports both npm audit report v1 (advisories map) and v2 (vulnerabilities map).
 *
 * @param {object} json
 * @returns {{ id: string; title: string | undefined }[]}
 */
function extractAdvisories(json) {
  const seen = new Set();
  const result = [];

  function add(id, title) {
    const key = id.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ id: key, title });
    }
  }

  // npm audit report v2: json.vulnerabilities[pkgName].via = (object | string)[]
  if (json.vulnerabilities && typeof json.vulnerabilities === 'object') {
    for (const vuln of Object.values(json.vulnerabilities)) {
      for (const via of Array.isArray(vuln.via) ? vuln.via : []) {
        if (typeof via !== 'object' || via === null) continue;
        if (via.url) {
          const m = String(via.url).match(/GHSA-[A-Za-z0-9-]+/i);
          if (m) add(m[0], via.title);
        }
        // CVE ids sometimes appear in a cve/cves field on the via object
        for (const cve of [].concat(via.cve ?? via.cves ?? [])) {
          add(String(cve), via.title);
        }
      }
    }
  }

  // npm audit report v1: json.advisories[numericId] = { url, cves, title, ... }
  if (json.advisories && typeof json.advisories === 'object') {
    for (const advisory of Object.values(json.advisories)) {
      if (advisory.url) {
        const m = String(advisory.url).match(/GHSA-[A-Za-z0-9-]+/i);
        if (m) add(m[0], advisory.title);
      }
      for (const cve of [].concat(advisory.cves ?? [])) {
        add(String(cve), advisory.title);
      }
    }
  }

  return result;
}

const advisories = extractAdvisories(auditJson);

if (advisories.length === 0) {
  process.stdout.write('[audit-check] No advisories found. PASS.\n');
  process.exit(0);
}

process.stdout.write(
  `[audit-check] ${advisories.length} advisory(ies) to evaluate.\n`,
);

// ── Check each advisory against the allowlist ──────────────────────────────

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
let failed = false;

for (const { id, title } of advisories) {
  const entry = allowedById.get(id);

  if (!entry) {
    process.stderr.write(
      `[audit-check] FAIL — ${id} is not in the allowlist.` +
        (title ? ` Title: ${title}` : '') +
        '\n',
    );
    failed = true;
    continue;
  }

  if (entry.expires < today) {
    process.stderr.write(
      `[audit-check] FAIL — allowlist entry for ${id} has EXPIRED (expired: ${entry.expires}). ` +
        `Renew the entry or fix the vulnerability.\n`,
    );
    failed = true;
    continue;
  }

  process.stdout.write(
    `[audit-check] SUPPRESSED — ${id} (expires: ${entry.expires}, reason: ${entry.reason})\n`,
  );
}

// ── Result ─────────────────────────────────────────────────────────────────

if (failed) {
  process.stderr.write(
    '[audit-check] Audit FAILED — fix vulnerabilities or update audit-allowlist.json.\n',
  );
  process.exit(1);
}

process.stdout.write('[audit-check] All advisories accounted for. PASS.\n');
process.exit(0);
