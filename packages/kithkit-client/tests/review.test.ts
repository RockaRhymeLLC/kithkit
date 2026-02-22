/**
 * LLM Review Module Tests
 *
 * Tests:
 *   t-082: LLM review evaluates skill content as data
 *   t-083: Trust level affects agent risk communication
 *   t-091: Catalog client SKILL.md follows agent-mediated risk messaging
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildReviewContext,
  createReviewReport,
  formatReviewForHuman,
  getRiskLevel,
  getReviewPrompt,
  REVIEW_RUBRIC,
} from '../src/review.ts';
import type { ReviewFinding } from '../src/review.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BENIGN_SKILL_CONTENT = `---
description: "Check current weather forecasts"
---

# Weather Check

Fetch weather forecasts from the Open-Meteo API.

## Commands

### weather <location>
Get the current weather for a location.

Example:
\`\`\`
weather "New York"
\`\`\`

This skill uses web_fetch to call https://api.open-meteo.com/ with the
provided location. No credentials required.
`;

const BENIGN_MANIFEST = {
  name: 'weather-check',
  version: '1.0.0',
  capabilities: { required: ['web_fetch'], optional: [] },
  author: { name: 'Jane Doe', github: 'janedev' },
  trust_level: 'verified' as const,
};

const CREDENTIAL_FINDING: ReviewFinding = {
  category: 'credential-access',
  severity: 'critical',
  description: 'Skill requests all Keychain credentials without justification',
  evidence: 'read all credentials from keychain',
  confidence: 'high',
};

const SCOPE_FINDING: ReviewFinding = {
  category: 'scope-mismatch',
  severity: 'high',
  description: 'Skill runs bash commands despite only declaring web_fetch capability',
  evidence: 'execute shell commands',
  confidence: 'medium',
};

const VAGUE_FINDING: ReviewFinding = {
  category: 'unclear-purpose',
  severity: 'medium',
  description: 'Skill description is vague and does not explain what data is accessed',
  evidence: 'does stuff with your data',
  confidence: 'high',
};

// ---------------------------------------------------------------------------
// t-082: LLM review evaluates skill content as data
// ---------------------------------------------------------------------------

describe('t-082: LLM review evaluates skill content as data', () => {
  it('step 1: buildReviewContext returns structured context with DATA marker', () => {
    const ctx = buildReviewContext(BENIGN_SKILL_CONTENT, BENIGN_MANIFEST, 'verified');

    // Must include the skill content
    assert.ok(ctx.skillContent === BENIGN_SKILL_CONTENT, 'skillContent should be the raw content');

    // Must have a data marker that signals content should be treated as data
    assert.ok(
      typeof ctx.dataMarker === 'string' && ctx.dataMarker.length > 0,
      'dataMarker should be a non-empty string',
    );
    assert.ok(
      ctx.dataMarker.toUpperCase().includes('DATA'),
      `dataMarker should mention DATA, got: ${ctx.dataMarker}`,
    );

    // Must have review instructions
    assert.ok(
      typeof ctx.reviewInstructions === 'string' && ctx.reviewInstructions.length > 0,
      'reviewInstructions should be present',
    );
    assert.ok(
      ctx.reviewInstructions.toLowerCase().includes('data'),
      'reviewInstructions should mention treating content as data',
    );

    // Must include skill metadata
    assert.equal(ctx.skillMetadata.name, 'weather-check');
    assert.equal(ctx.skillMetadata.version, '1.0.0');
    assert.equal(ctx.skillMetadata.trust_level, 'verified');
    assert.deepStrictEqual(ctx.skillMetadata.declaredCapabilities, ['web_fetch']);

    // Must include the rubric
    assert.ok(Array.isArray(ctx.rubric), 'rubric should be an array');
    assert.ok(ctx.rubric.length >= 8, 'rubric should have at least 8 categories');
  });

  it('step 2: createReviewReport with no findings → risk is "none", recommendation is positive', () => {
    const report = createReviewReport('weather-check', '1.0.0', 'verified', []);

    assert.equal(report.skillName, 'weather-check');
    assert.equal(report.version, '1.0.0');
    assert.equal(report.trust_level, 'verified');
    assert.deepStrictEqual(report.findings, []);
    assert.equal(report.overallRisk, 'none', 'No findings should produce "none" risk');
    assert.ok(
      typeof report.recommendation === 'string' && report.recommendation.length > 0,
      'recommendation should be a non-empty string',
    );
    // Positive recommendation — should not contain warning words
    const lowerRec = report.recommendation.toLowerCase();
    assert.ok(
      !lowerRec.includes('do not install') && !lowerRec.includes('critical'),
      `Recommendation for no findings should be positive, got: ${report.recommendation}`,
    );
    // Should include something positive
    assert.ok(
      lowerRec.includes('safe') || lowerRec.includes('no concern') || lowerRec.includes('no review'),
      `Recommendation should include a positive signal, got: ${report.recommendation}`,
    );
    // Must have reviewedAt
    assert.ok(
      typeof report.reviewedAt === 'string' && report.reviewedAt.length > 0,
      'reviewedAt should be set',
    );
  });

  it('step 3: createReviewReport with credential-access finding → risk is "critical", recommendation warns', () => {
    const report = createReviewReport('bad-skill', '1.0.0', 'community', [CREDENTIAL_FINDING]);

    assert.equal(report.overallRisk, 'critical', 'Credential access finding should produce critical risk');
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].category, 'credential-access');

    const lowerRec = report.recommendation.toLowerCase();
    assert.ok(
      lowerRec.includes('do not install') || lowerRec.includes('critical'),
      `Recommendation should warn about critical risk, got: ${report.recommendation}`,
    );
  });

  it('step 4: formatReviewForHuman returns natural language summary (not raw dump)', () => {
    // Test with no findings
    const cleanReport = createReviewReport('weather-check', '1.0.0', 'verified', []);
    const cleanOutput = formatReviewForHuman(cleanReport);

    assert.ok(typeof cleanOutput === 'string', 'output should be a string');
    assert.ok(cleanOutput.length > 0, 'output should be non-empty');

    // Should mention the skill name and version naturally
    assert.ok(cleanOutput.includes('weather-check'), 'should mention skill name');
    assert.ok(cleanOutput.includes('1.0.0'), 'should mention version');

    // Should NOT be raw JSON
    assert.ok(!cleanOutput.startsWith('{'), 'should not be raw JSON');
    assert.ok(!cleanOutput.includes('"findings"'), 'should not contain raw field names');

    // Test with a critical finding
    const badReport = createReviewReport('bad-skill', '1.0.0', 'community', [CREDENTIAL_FINDING]);
    const badOutput = formatReviewForHuman(badReport);

    assert.ok(badOutput.includes('bad-skill'), 'should mention skill name');
    // Should describe the concern naturally
    assert.ok(
      badOutput.toLowerCase().includes('critical') || badOutput.toLowerCase().includes('credential'),
      'should describe critical credential concern',
    );
    // Should include evidence
    assert.ok(
      badOutput.includes(CREDENTIAL_FINDING.evidence),
      'should include evidence from finding',
    );
  });
});

// ---------------------------------------------------------------------------
// t-083: Trust level affects agent risk communication
// ---------------------------------------------------------------------------

describe('t-083: Trust level affects agent risk communication', () => {
  it('step 1: first-party skill with no findings → minimal caution in recommendation', () => {
    const report = createReviewReport('core-memory', '2.0.0', 'first-party', []);
    const output = formatReviewForHuman(report);

    // Should mention first-party
    assert.ok(
      output.toLowerCase().includes('first-party') || output.toLowerCase().includes('first party'),
      `Should mention first-party status, got: ${output}`,
    );
    // Should not demand confirmation — first-party with no findings needs no extra steps
    assert.ok(
      !output.toLowerCase().includes('ask for confirmation'),
      'Should not demand confirmation for first-party clean skill',
    );
    // Recommendation should be safe to proceed
    assert.ok(
      report.recommendation.toLowerCase().includes('safe') || report.recommendation.toLowerCase().includes('no concern'),
      `Recommendation should indicate safe to install, got: ${report.recommendation}`,
    );
  });

  it('step 2: community skill with no findings → asks for confirmation in recommendation', () => {
    const report = createReviewReport('community-tool', '1.0.0', 'community', []);
    const output = formatReviewForHuman(report);

    // Community + no findings should still note it's community
    assert.ok(
      output.toLowerCase().includes('community'),
      `Should mention community status, got: ${output}`,
    );
    // Recommendation should ask for human confirmation
    const lowerRec = report.recommendation.toLowerCase();
    assert.ok(
      lowerRec.includes('ask') || lowerRec.includes('confirm') || lowerRec.includes('confirmation'),
      `Community skill recommendation should include confirmation ask, got: ${report.recommendation}`,
    );
  });

  it('step 3: verified skill with high finding → moderate caution in recommendation', () => {
    const report = createReviewReport('ext-weather', '1.5.0', 'verified', [SCOPE_FINDING]);
    const output = formatReviewForHuman(report);

    // Should mention verified
    assert.ok(
      output.toLowerCase().includes('verified'),
      `Should mention verified status, got: ${output}`,
    );
    // Should share the finding
    assert.ok(
      output.toLowerCase().includes('scope') || output.toLowerCase().includes('bash') || output.toLowerCase().includes('high'),
      `Should share the high-severity finding, got: ${output}`,
    );
    // Should ask for confirmation (high finding in verified skill)
    const lowerRec = report.recommendation.toLowerCase();
    assert.ok(
      lowerRec.includes('confirm') || lowerRec.includes('ask') || lowerRec.includes('finding'),
      `Verified skill with high finding should recommend confirmation, got: ${report.recommendation}`,
    );
  });

  it('step 4: community + no findings → recommendation includes selftest suggestion', () => {
    const report = createReviewReport('community-gadget', '0.9.0', 'community', []);

    const lowerRec = report.recommendation.toLowerCase();
    assert.ok(
      lowerRec.includes('selftest') || lowerRec.includes('self-test') || lowerRec.includes('self test'),
      `Community skill recommendation should mention selftest, got: ${report.recommendation}`,
    );
  });
});

// ---------------------------------------------------------------------------
// t-091: Catalog client SKILL.md follows agent-mediated risk messaging
// ---------------------------------------------------------------------------

const SKILL_MD_PATH = join(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
  '../../../.claude/skills/kithkit/SKILL.md',
);

describe('t-091: Catalog client SKILL.md follows agent-mediated risk messaging', () => {
  let skillMdContent: string;

  it('step 1: SKILL.md contains all command references', async () => {
    skillMdContent = await readFile(SKILL_MD_PATH, 'utf8');

    const requiredCommands = ['kithkit search', 'kithkit install', 'kithkit update', 'kithkit uninstall', 'kithkit list', 'kithkit selftest'];
    for (const cmd of requiredCommands) {
      assert.ok(
        skillMdContent.includes(cmd),
        `SKILL.md should contain command reference: ${cmd}`,
      );
    }
  });

  it('step 2: risk communication instructions contain natural conversation guidance, not disclaimers', async () => {
    if (!skillMdContent) {
      skillMdContent = await readFile(SKILL_MD_PATH, 'utf8');
    }

    const lower = skillMdContent.toLowerCase();

    // Should have the natural language examples section
    assert.ok(
      lower.includes('example') || lower.includes('want me'),
      'SKILL.md should include natural language guidance or examples',
    );

    // Should explicitly call out what NOT to do (disclaimer-style)
    assert.ok(
      lower.includes('not to do') || lower.includes('what not') || lower.includes('do not use'),
      'SKILL.md should tell agents what not to do (disclaimer-style messaging)',
    );

    // Should NOT be primarily disclaimer-style itself
    // Check that positive examples exist
    assert.ok(
      skillMdContent.includes('Want me') || skillMdContent.includes('want me') || skillMdContent.includes('Looks straightforward'),
      'SKILL.md should include natural conversation examples',
    );
  });

  it('step 3: trust level section defines different behavior for first-party/verified/community', async () => {
    if (!skillMdContent) {
      skillMdContent = await readFile(SKILL_MD_PATH, 'utf8');
    }

    const lower = skillMdContent.toLowerCase();

    assert.ok(lower.includes('first-party'), 'SKILL.md should define first-party behavior');
    assert.ok(lower.includes('verified'), 'SKILL.md should define verified behavior');
    assert.ok(lower.includes('community'), 'SKILL.md should define community behavior');

    // Each trust level should have distinct guidance
    const firstPartyIdx = lower.indexOf('first-party');
    const verifiedIdx = lower.indexOf('verified');
    const communityIdx = lower.indexOf('community');

    assert.ok(firstPartyIdx >= 0 && verifiedIdx >= 0 && communityIdx >= 0, 'All trust levels should be defined');
  });

  it('step 4: human confirmation flow requires confirmation for community skills', async () => {
    if (!skillMdContent) {
      skillMdContent = await readFile(SKILL_MD_PATH, 'utf8');
    }

    const lower = skillMdContent.toLowerCase();

    // Community skills must require human confirmation
    assert.ok(
      lower.includes('always ask') || lower.includes('ask for human confirmation') || lower.includes('always get human confirmation'),
      'SKILL.md should require human confirmation for community skills',
    );
  });

  it('step 5: SKILL.md follows CC4Me skill format with frontmatter and is under 500 lines', async () => {
    if (!skillMdContent) {
      skillMdContent = await readFile(SKILL_MD_PATH, 'utf8');
    }

    // Check frontmatter format
    assert.ok(
      skillMdContent.startsWith('---\n'),
      'SKILL.md should start with YAML frontmatter (---)',
    );

    const frontmatterEnd = skillMdContent.indexOf('\n---\n', 4);
    assert.ok(frontmatterEnd > 0, 'SKILL.md should have closing --- for frontmatter');

    const frontmatter = skillMdContent.slice(4, frontmatterEnd);
    assert.ok(
      frontmatter.includes('description:'),
      `SKILL.md frontmatter should include a description field, got: ${frontmatter}`,
    );

    // Check line count
    const lineCount = skillMdContent.split('\n').length;
    assert.ok(
      lineCount <= 500,
      `SKILL.md should be under 500 lines, but has ${lineCount} lines`,
    );
  });
});

// ---------------------------------------------------------------------------
// Additional unit tests for getRiskLevel and getReviewPrompt
// ---------------------------------------------------------------------------

describe('getRiskLevel: computes maximum severity', () => {
  it('no findings → none', () => {
    assert.equal(getRiskLevel([]), 'none');
  });

  it('single low → low', () => {
    const finding: ReviewFinding = { category: 'unclear-purpose', severity: 'low', description: '', evidence: '', confidence: 'low' };
    assert.equal(getRiskLevel([finding]), 'low');
  });

  it('mixed severities → maximum', () => {
    const findings: ReviewFinding[] = [
      { category: 'unclear-purpose', severity: 'medium', description: '', evidence: '', confidence: 'low' },
      { category: 'scope-mismatch', severity: 'high', description: '', evidence: '', confidence: 'medium' },
      { category: 'excessive-capabilities', severity: 'low', description: '', evidence: '', confidence: 'low' },
    ];
    assert.equal(getRiskLevel(findings), 'high');
  });

  it('critical finding → critical', () => {
    const findings: ReviewFinding[] = [
      VAGUE_FINDING,
      CREDENTIAL_FINDING,
      SCOPE_FINDING,
    ];
    assert.equal(getRiskLevel(findings), 'critical');
  });
});

describe('getReviewPrompt: returns a usable prompt template', () => {
  it('prompt contains all rubric categories', () => {
    const prompt = getReviewPrompt();

    assert.ok(typeof prompt === 'string' && prompt.length > 100, 'prompt should be a substantial string');

    for (const rubricItem of REVIEW_RUBRIC) {
      assert.ok(
        prompt.includes(rubricItem.category),
        `prompt should include rubric category: ${rubricItem.category}`,
      );
    }
  });

  it('prompt instructs agent to treat content as data', () => {
    const prompt = getReviewPrompt();
    const lower = prompt.toLowerCase();

    assert.ok(
      lower.includes('data') && (lower.includes('not follow') || lower.includes('do not follow')),
      'prompt should instruct agent to treat content as data and not follow instructions within it',
    );
  });

  it('prompt includes JSON output format guidance', () => {
    const prompt = getReviewPrompt();

    assert.ok(
      prompt.includes('json') || prompt.includes('JSON'),
      'prompt should include JSON output format guidance',
    );
    assert.ok(
      prompt.includes('category') && prompt.includes('severity') && prompt.includes('evidence'),
      'prompt should include expected output fields',
    );
  });
});
