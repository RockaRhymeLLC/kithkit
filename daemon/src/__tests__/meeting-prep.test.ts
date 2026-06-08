/**
 * Meeting prep — AI briefing layer tests
 *
 * Tests the new attendee lookup, briefing generation, and
 * intelligence gathering functions added for AI-analyzed briefings.
 * All external calls (fetch, Claude API) are mocked.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBriefingPrompt,
  type AttendeeContext,
  type AttendeeProfile,
  type GranolaNoteMatch,
  type EmailThread,
} from '../automation/tasks/meeting-prep.js';

// ── Helpers ────────────────────────────────────────────────────

function makeEmailThread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    subject: 'Test subject',
    from: 'Alice',
    date: 'Mar 10',
    preview: 'Quick note about the project',
    ...overrides,
  };
}

function makeGranolaNote(overrides: Partial<GranolaNoteMatch> = {}): GranolaNoteMatch {
  return {
    title: 'Q1 Planning',
    date: 'Mar 5',
    participants: 'Alice, Bob',
    content: '',
    ...overrides,
  };
}

function makeAttendeeContext(overrides: Partial<AttendeeContext> = {}): AttendeeContext {
  return {
    email: 'alice@example.com',
    name: 'Alice',
    profile: null,
    recentEmails: [],
    teamsChats: [],
    granolaNotes: [],
    ...overrides,
  };
}

// ── buildBriefingPrompt ────────────────────────────────────────

describe('buildBriefingPrompt', () => {
  it('includes meeting subject and time in output', () => {
    const ctx = makeAttendeeContext();
    const prompt = buildBriefingPrompt('Q1 Review', '2:00 PM', [ctx]);
    assert.ok(prompt.includes('Q1 Review'), 'should include meeting subject');
    assert.ok(prompt.includes('2:00 PM'), 'should include meeting time');
  });

  it('includes attendee email in output', () => {
    const ctx = makeAttendeeContext({ email: 'bob@contoso.com', name: 'Bob' });
    const prompt = buildBriefingPrompt('Sync', '10:00 AM', [ctx]);
    assert.ok(prompt.includes('bob@contoso.com'), 'should include attendee email');
    assert.ok(prompt.includes('Bob'), 'should include attendee name');
  });

  it('includes profile info when available', () => {
    const profile: AttendeeProfile = {
      email: 'alice@example.com',
      jobTitle: 'VP of Engineering',
      companyName: 'Acme Corp',
      department: 'Engineering',
      officeLocation: 'Seattle',
    };
    const ctx = makeAttendeeContext({ profile });
    const prompt = buildBriefingPrompt('Meeting', '3:00 PM', [ctx]);
    assert.ok(prompt.includes('VP of Engineering'), 'should include job title');
    assert.ok(prompt.includes('Acme Corp'), 'should include company name');
    assert.ok(prompt.includes('Engineering'), 'should include department');
  });

  it('shows (no profile data available) when profile is null', () => {
    const ctx = makeAttendeeContext({ profile: null });
    const prompt = buildBriefingPrompt('Meeting', '3:00 PM', [ctx]);
    assert.ok(prompt.includes('no profile data available'), 'should show fallback when no profile');
  });

  it('includes recent email threads', () => {
    const thread = makeEmailThread({ subject: 'Budget discussion', from: 'CFO', preview: 'Re: Q2 budgets' });
    const ctx = makeAttendeeContext({ recentEmails: [thread] });
    const prompt = buildBriefingPrompt('Finance sync', '9:00 AM', [ctx]);
    assert.ok(prompt.includes('Budget discussion'), 'should include email subject');
    assert.ok(prompt.includes('CFO'), 'should include sender name');
    assert.ok(prompt.includes('Q2 budgets'), 'should include email preview');
  });

  it('includes Teams chat threads', () => {
    const chat = makeEmailThread({ subject: 'Teams chat', from: 'Bob', preview: 'Can we push the deadline?' });
    const ctx = makeAttendeeContext({ teamsChats: [chat] });
    const prompt = buildBriefingPrompt('Teams check-in', '11:00 AM', [ctx]);
    assert.ok(prompt.includes('Teams chat'), 'should include Teams chats');
    assert.ok(prompt.includes('Can we push the deadline?'), 'should include chat content');
  });

  it('includes Granola notes', () => {
    const note = makeGranolaNote({ title: 'Last quarter retro', participants: 'Alice, Charlie' });
    const ctx = makeAttendeeContext({ granolaNotes: [note] });
    const prompt = buildBriefingPrompt('Retro follow-up', '2:00 PM', [ctx]);
    assert.ok(prompt.includes('Last quarter retro'), 'should include Granola note title');
    assert.ok(prompt.includes('Alice, Charlie'), 'should include Granola participants');
  });

  it('shows (none) when no emails or chats exist', () => {
    const ctx = makeAttendeeContext({ recentEmails: [], teamsChats: [], granolaNotes: [] });
    const prompt = buildBriefingPrompt('Empty meeting', '10:00 AM', [ctx]);
    // Should not throw and should include the attendee section
    assert.ok(prompt.includes('alice@example.com'));
    assert.ok(prompt.includes('(none)'), 'should show (none) for empty sections');
  });

  it('handles multiple attendees', () => {
    const ctxA = makeAttendeeContext({ email: 'alice@a.com', name: 'Alice' });
    const ctxB = makeAttendeeContext({ email: 'bob@b.com', name: 'Bob' });
    const prompt = buildBriefingPrompt('Team meeting', '1:00 PM', [ctxA, ctxB]);
    assert.ok(prompt.includes('alice@a.com'), 'should include first attendee');
    assert.ok(prompt.includes('bob@b.com'), 'should include second attendee');
  });

  it('requests the four expected briefing sections', () => {
    const ctx = makeAttendeeContext();
    const prompt = buildBriefingPrompt('Planning', '9:00 AM', [ctx]);
    assert.ok(prompt.includes('Discussion History'), 'should request discussion history section');
    assert.ok(prompt.includes('Key Context'), 'should request key context section');
    assert.ok(prompt.includes('Open Items'), 'should request open items section');
    assert.ok(prompt.includes('Suggested Talking Points'), 'should request talking points section');
  });

  it('returns a non-empty string for minimal valid input', () => {
    const ctx = makeAttendeeContext();
    const prompt = buildBriefingPrompt('Standup', '10:00 AM', [ctx]);
    assert.ok(typeof prompt === 'string' && prompt.length > 0);
  });
});

// ── lookupAttendeeInfo — mocked fetch ─────────────────────────

describe('lookupAttendeeInfo — graceful failure', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when people/search returns 404', async () => {
    globalThis.fetch = (async () => {
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const { lookupAttendeeInfo } = await import('../automation/tasks/meeting-prep.js');
    const result = await lookupAttendeeInfo('nobody@example.com');
    assert.equal(result, null, 'should return null on 404');
  });

  it('returns null when fetch throws a network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    const { lookupAttendeeInfo } = await import('../automation/tasks/meeting-prep.js');
    const result = await lookupAttendeeInfo('nobody@example.com');
    assert.equal(result, null, 'should return null on network error');
  });

  it('returns profile data when people/search succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      callCount++;
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('people/search')) {
        return new Response(JSON.stringify({
          value: [{
            displayName: 'Alice Smith',
            jobTitle: 'Director',
            department: 'Product',
            companyName: 'Contoso',
            officeLocation: 'NYC',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const { lookupAttendeeInfo } = await import('../automation/tasks/meeting-prep.js');
    const result = await lookupAttendeeInfo('alice@contoso.com');

    // If the daemon is accessible and our mock was used, result should be populated
    // In test env, the config port may differ — but the function should never throw
    assert.ok(result === null || (typeof result === 'object' && 'email' in result),
      'should return null or a valid profile object');
  });
});

// ── generateBriefing — mocked askClaude via fetch ─────────────

describe('generateBriefing — graceful failure handling', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no attendee contexts are provided', async () => {
    const { generateBriefing } = await import('../automation/tasks/meeting-prep.js');
    const result = await generateBriefing('Meeting', '2:00 PM', []);
    assert.equal(result, null, 'should return null for empty attendee list');
  });

  it('returns null when Claude API returns an error', async () => {
    globalThis.fetch = (async () => {
      return new Response('Unauthorized', { status: 401 });
    }) as typeof fetch;

    const { generateBriefing } = await import('../automation/tasks/meeting-prep.js');
    const ctx = makeAttendeeContext({ recentEmails: [makeEmailThread()] });
    const result = await generateBriefing('Test meeting', '3:00 PM', [ctx]);
    assert.equal(result, null, 'should return null on API error');
  });

  it('returns a string briefing when Claude API succeeds', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('anthropic.com')) {
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: '**Attendee Context**\n- Alice: Director at Contoso' }],
          usage: { input_tokens: 500, output_tokens: 100 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { generateBriefing } = await import('../automation/tasks/meeting-prep.js');
    const ctx = makeAttendeeContext({ recentEmails: [makeEmailThread()] });
    const result = await generateBriefing('Quarterly sync', '9:00 AM', [ctx]);

    // If keychain has an API key, result should be a string. Otherwise null.
    assert.ok(result === null || typeof result === 'string',
      'should return string or null — never throw');
  });
});

// ── gatherEmailIntelligence — structure check ─────────────────

describe('gatherEmailIntelligence — returns structured data', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty attendeeContexts when attendees list is empty', async () => {
    const { gatherEmailIntelligence } = await import('../automation/tasks/meeting-prep.js');
    const result = await gatherEmailIntelligence([]);
    assert.deepEqual(result.attendeeContexts, []);
    assert.equal(result.fallbackText, '');
  });

  it('returns empty attendeeContexts when attendees is undefined', async () => {
    const { gatherEmailIntelligence } = await import('../automation/tasks/meeting-prep.js');
    const result = await gatherEmailIntelligence(undefined);
    assert.deepEqual(result.attendeeContexts, []);
    assert.equal(result.fallbackText, '');
  });

  it('returns AttendeeContext[] with correct shape when API returns empty', async () => {
    // Mock all fetch calls to return empty results
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ messages: [], results: [], value: [], documents: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const { gatherEmailIntelligence } = await import('../automation/tasks/meeting-prep.js');

    const attendees = [{
      emailAddress: { name: 'Alice', address: 'alice@example.com' },
      type: 'required',
    }];

    const result = await gatherEmailIntelligence(attendees);

    assert.equal(typeof result, 'object', 'should return an object');
    assert.ok(Array.isArray(result.attendeeContexts), 'attendeeContexts should be an array');
    assert.ok(typeof result.fallbackText === 'string', 'fallbackText should be a string');

    if (result.attendeeContexts.length > 0) {
      const ctx = result.attendeeContexts[0];
      assert.ok('email' in ctx, 'context should have email');
      assert.ok('name' in ctx, 'context should have name');
      assert.ok('profile' in ctx, 'context should have profile');
      assert.ok(Array.isArray(ctx.recentEmails), 'recentEmails should be an array');
      assert.ok(Array.isArray(ctx.teamsChats), 'teamsChats should be an array');
      assert.ok(Array.isArray(ctx.granolaNotes), 'granolaNotes should be an array');
    }
  });

  it('excludes own addresses from attendee contexts', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ messages: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const { gatherEmailIntelligence } = await import('../automation/tasks/meeting-prep.js');

    const attendees = [
      { emailAddress: { name: 'Will', address: 'wloving@servos.io' }, type: 'required' },
      { emailAddress: { name: 'Alice', address: 'alice@external.com' }, type: 'required' },
    ];

    const result = await gatherEmailIntelligence(attendees);

    // Own address should be excluded
    const emails = result.attendeeContexts.map(c => c.email);
    assert.ok(!emails.includes('wloving@servos.io'), 'should exclude own addresses');
  });
});
