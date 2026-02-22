#!/usr/bin/env npx tsx
/**
 * Memory Triage Script — Classifies v1 memories for migration to v2.
 *
 * Categories:
 * - keep-as-is: Good memories that can import directly
 * - rewrite: Valid content but references v1 patterns (flat files, old APIs)
 * - stale: Outdated, superseded, or no longer relevant
 * - credential-ref: References credentials/PII (needs security review)
 * - skip: Duplicate, empty, or malformed
 *
 * Usage:
 *   npx tsx scripts/triage-memories.ts [--dry-run] [--limit N] [--sample N]
 *   npx tsx scripts/triage-memories.ts --report  # Show existing report
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Config ──────────────────────────────────────────────────

const V1_MEMORIES_DIR = path.join(process.env.HOME!, 'CC4Me-BMO/.claude/state/memory/memories');
const REPORT_PATH = path.join(process.env.HOME!, 'KKit-BMO/scripts/triage-report.json');

type Category = 'keep-as-is' | 'rewrite' | 'stale' | 'credential-ref' | 'skip';

interface TriageResult {
  file: string;
  subject: string;
  v1Category: string;
  triageCategory: Category;
  reason: string;
  tags: string[];
  importance: number;
  v2Type: 'fact' | 'episodic' | 'procedural';
  v2Category: string;
  needsRewrite: string[]; // list of things that need updating
}

interface FrontMatter {
  date?: string;
  category?: string;
  importance?: number;
  subject?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  [key: string]: unknown;
}

// ── Frontmatter Parser ──────────────────────────────────────

function parseFrontMatter(content: string): { meta: FrontMatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const meta: FrontMatter = {};

  for (const line of yamlStr.split('\n')) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val.startsWith('[')) {
      // Parse YAML array: [tag1, tag2, tag3]
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else if (val === 'true') {
      meta[key] = true;
    } else if (val === 'false') {
      meta[key] = false;
    } else if (/^\d+(\.\d+)?$/.test(val)) {
      meta[key] = parseFloat(val);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }

  return { meta, body };
}

// ── Stale Detectors ─────────────────────────────────────────

const STALE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Deprecated v1 modules
  { pattern: /cc4me-gateway/i, reason: 'References deprecated cc4me-gateway' },
  { pattern: /bmobot-gateway/i, reason: 'References deprecated bmobot-gateway' },
  { pattern: /relay\.js|relay-client/i, reason: 'References old relay client (v1)' },
  { pattern: /cloudflare tunnel.*gateway/i, reason: 'References old gateway tunnel setup' },
  // v1 flat file patterns
  { pattern: /\.claude\/state\/memory\/memories\//i, reason: 'References v1 flat file memory path' },
  { pattern: /\.claude\/state\/todos\//i, reason: 'References v1 flat file todo path' },
  { pattern: /credential-gateway/i, reason: 'References deprecated gateway credential' },
  // Old daemon patterns
  { pattern: /sendTelegramMessage|sendTelegram\(/i, reason: 'References v1 Telegram function' },
  { pattern: /checkAllUnread/i, reason: 'References v1 email function' },
  { pattern: /registerTask\(/i, reason: 'References v1 task registration' },
  { pattern: /getCredential\(/i, reason: 'References v1 credential function' },
  // Completed/past events
  { pattern: /\b2025\b.*\b(deadline|due|expires|migration)\b/i, reason: 'References 2025 deadline/event' },
];

const REWRITE_PATTERNS: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /cc4me\.config\.yaml/i, note: 'Update config file reference to kithkit.config.yaml' },
  { pattern: /CC4Me(?!.*Network)/i, note: 'Rename CC4Me references to Kithkit' },
  { pattern: /\.claude\/state\//i, note: 'Update flat file state paths to daemon API' },
  { pattern: /daemon\/src\/(comms|automation|core)\//i, note: 'Update daemon source paths' },
  { pattern: /sendTelegramMessage|sendTelegram/i, note: 'Update to v2 Telegram adapter API' },
  { pattern: /getCredential|getAgentCommsSecret/i, note: 'Update to v2 readKeychain' },
];

const CREDENTIAL_PATTERNS = [
  /credential-/i,
  /pii-/i,
  /financial-/i,
  /api[_-]?key/i,
  /secret[_-]?key/i,
  /password/i,
  /Keychain/i,
  /\.env\b/,
];

// ── Classification Logic ────────────────────────────────────

function mapV2Type(v1Category: string): 'fact' | 'episodic' | 'procedural' {
  switch (v1Category) {
    case 'person':
    case 'technical':
    case 'system':
    case 'integration':
    case 'security':
    case 'infrastructure':
      return 'fact';
    case 'workflow':
    case 'process':
    case 'development':
      return 'procedural';
    case 'project':
    case 'social':
    case 'communication':
      return 'episodic';
    default:
      return 'fact';
  }
}

function mapV2Category(v1Category: string, tags: string[]): string {
  // Map v1 categories to v2 categories
  if (v1Category === 'person') return 'people';
  if (v1Category === 'system' || v1Category === 'infrastructure') return 'system';
  if (v1Category === 'integration') return 'integration';
  if (v1Category === 'security') return 'security';
  if (v1Category === 'workflow' || v1Category === 'process') return 'workflow';
  if (v1Category === 'development' || v1Category === 'project') return 'project';
  if (tags.includes('architecture')) return 'architecture';
  return v1Category || 'general';
}

function classifyMemory(file: string, meta: FrontMatter, body: string): TriageResult {
  const fullContent = body + '\n' + (meta.subject || '');
  const tags = meta.tags || [];
  const importance = meta.importance ?? 3;
  const subject = meta.subject || file;
  const v1Category = meta.category || 'unknown';

  // Check for empty/malformed
  if (!body.trim() || body.trim().length < 10) {
    return {
      file, subject, v1Category, tags, importance,
      triageCategory: 'skip',
      reason: 'Empty or too short',
      v2Type: mapV2Type(v1Category),
      v2Category: mapV2Category(v1Category, tags),
      needsRewrite: [],
    };
  }

  // Check for credential references
  const hasCredentialRef = CREDENTIAL_PATTERNS.some(p => p.test(fullContent));

  // Check for stale patterns
  const staleMatches = STALE_PATTERNS.filter(s => s.pattern.test(fullContent));

  // Check for rewrite needs
  const rewriteNeeds = REWRITE_PATTERNS
    .filter(r => r.pattern.test(fullContent))
    .map(r => r.note);

  // Decision logic
  let triageCategory: Category;
  let reason: string;

  if (staleMatches.length > 0 && importance <= 2) {
    triageCategory = 'stale';
    reason = staleMatches.map(s => s.reason).join('; ');
  } else if (hasCredentialRef) {
    triageCategory = 'credential-ref';
    reason = 'Contains credential/PII references — needs security review';
  } else if (rewriteNeeds.length > 0) {
    triageCategory = 'rewrite';
    reason = `Needs updates: ${rewriteNeeds.join(', ')}`;
  } else if (staleMatches.length > 0) {
    // Stale but important — mark for rewrite instead of discard
    triageCategory = 'rewrite';
    reason = `Important but has stale refs: ${staleMatches.map(s => s.reason).join('; ')}`;
  } else {
    triageCategory = 'keep-as-is';
    reason = 'Clean — no stale patterns or rewrite needs detected';
  }

  return {
    file, subject, v1Category, tags, importance,
    triageCategory,
    reason,
    v2Type: mapV2Type(v1Category),
    v2Category: mapV2Category(v1Category, tags),
    needsRewrite: rewriteNeeds,
  };
}

// ── Main ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const showReport = args.includes('--report');
  const dryRun = args.includes('--dry-run');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;
  const sampleArg = args.indexOf('--sample');
  const sampleSize = sampleArg !== -1 ? parseInt(args[sampleArg + 1]) : 0;

  if (showReport) {
    if (!fs.existsSync(REPORT_PATH)) {
      console.error('No report found. Run triage first.');
      process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    console.log(JSON.stringify(report.summary, null, 2));
    return;
  }

  // Read all memory files
  const files = fs.readdirSync(V1_MEMORIES_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();

  console.log(`Found ${files.length} memory files`);

  let filesToProcess = files;
  if (sampleSize > 0) {
    // Random sample
    const shuffled = [...files].sort(() => Math.random() - 0.5);
    filesToProcess = shuffled.slice(0, sampleSize);
    console.log(`Sampling ${sampleSize} memories for dry run`);
  }
  if (limit < filesToProcess.length) {
    filesToProcess = filesToProcess.slice(0, limit);
  }

  const results: TriageResult[] = [];

  for (const file of filesToProcess) {
    const content = fs.readFileSync(path.join(V1_MEMORIES_DIR, file), 'utf8');
    const { meta, body } = parseFrontMatter(content);
    const result = classifyMemory(file, meta, body);
    results.push(result);
  }

  // Summary
  const summary = {
    total: results.length,
    keepAsIs: results.filter(r => r.triageCategory === 'keep-as-is').length,
    rewrite: results.filter(r => r.triageCategory === 'rewrite').length,
    stale: results.filter(r => r.triageCategory === 'stale').length,
    credentialRef: results.filter(r => r.triageCategory === 'credential-ref').length,
    skip: results.filter(r => r.triageCategory === 'skip').length,
  };

  console.log('\n=== Triage Summary ===');
  console.log(`Total:          ${summary.total}`);
  console.log(`Keep as-is:     ${summary.keepAsIs} (${pct(summary.keepAsIs, summary.total)})`);
  console.log(`Needs rewrite:  ${summary.rewrite} (${pct(summary.rewrite, summary.total)})`);
  console.log(`Stale:          ${summary.stale} (${pct(summary.stale, summary.total)})`);
  console.log(`Credential ref: ${summary.credentialRef} (${pct(summary.credentialRef, summary.total)})`);
  console.log(`Skip:           ${summary.skip} (${pct(summary.skip, summary.total)})`);

  if (!dryRun) {
    // Write full report
    const report = {
      generated: new Date().toISOString(),
      source: V1_MEMORIES_DIR,
      summary,
      results,
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${REPORT_PATH}`);
  }

  // Show some examples from each category
  if (sampleSize > 0 || dryRun) {
    for (const cat of ['stale', 'rewrite', 'credential-ref', 'skip'] as Category[]) {
      const examples = results.filter(r => r.triageCategory === cat).slice(0, 3);
      if (examples.length > 0) {
        console.log(`\n--- ${cat} examples ---`);
        for (const ex of examples) {
          console.log(`  ${ex.file}: ${ex.reason}`);
        }
      }
    }
  }
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round(n / total * 100)}%`;
}

main();
