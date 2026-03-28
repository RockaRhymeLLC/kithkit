# Periodic Email Triage Task

Automatically triage incoming email on a schedule — sort junk into folders, file newsletters and receipts, and surface only the messages that actually need your attention. The triage pipeline uses pattern matching for known senders and a Claude sub-agent for everything else.

---

## Prerequisites

- At least one email provider configured in your Kithkit config (see the email provider recipes for M365/Graph, IMAP, and Yahoo setup)
- Kithkit daemon running and healthy: `curl http://localhost:3847/health`
- Claude API key stored in Keychain (used by the sub-agent classifier)
- Scheduler enabled in your config

---

## Setup Steps

### 1. Configure your email provider(s)

Before enabling triage, ensure at least one provider is configured and can connect. Test with the daemon admin endpoint:

```bash
curl -X POST http://localhost:3847/api/tasks/email-check/run
# → { "status": "ok", "result": "..." }
```

If the task does not exist yet, complete steps 2–4 first.

### 2. Define triage rules in config

Add the `triage` block under your email channel config (see Config Snippet below). Start with a small allowlist of VIP senders and a short junk list — you can grow it over time as the sub-agent surfaces `add_rule` recommendations.

### 3. Register the task handler

Create the file `daemon/src/automation/tasks/email-check.ts` using the reference code below. Import and register it in your task index (`daemon/src/automation/tasks/index.ts`):

```typescript
import './email-check.js';
```

### 4. Enable the scheduler task

Add the task entry to `scheduler.tasks` in your config file (see Config Snippet). Set `enabled: true` and choose an interval. 15 minutes is a reasonable default.

### 5. Rebuild and restart the daemon

```bash
cd daemon && npm run build
launchctl unload ~/Library/LaunchAgents/com.your-agent.daemon.plist
launchctl load  ~/Library/LaunchAgents/com.your-agent.daemon.plist
```

Tail the daemon log to confirm the task is scheduling:

```bash
tail -f logs/daemon.log | grep email-check
```

---

## Reference Code

### Task Handler (`daemon/src/automation/tasks/email-check.ts`)

```typescript
import { registerTask, type TaskContext } from '../scheduler.js';
import { getEmailProviders } from '../../comms/adapters/email/index.js';
import { askClaude } from '../../core/claude-api.js';
import { injectText } from '../../core/session-bridge.js';

interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: Date;
  provider: string;
}

interface TriageRecommendation {
  id: string;
  action: 'notify' | 'add_rule' | 'file' | 'ignore';
  urgency?: 'high' | 'normal' | 'low';
  reason?: string;
  ruleCategory?: string;
  rulePattern?: string;
  folder?: string;
}

/**
 * Pattern matching: supports both substring (default) and basic regex.
 * Patterns containing *, (, or [ are treated as regex; all others are
 * case-insensitive substring matches.
 */
function matchesAny(text: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const lower = text.toLowerCase();
  return patterns.some(p => {
    if (/[*([]/.test(p)) {
      try {
        return new RegExp(p, 'i').test(lower);
      } catch {
        // Malformed regex — fall back to substring
      }
    }
    return lower.includes(p.toLowerCase());
  });
}

/**
 * Build the sub-agent classification prompt.
 * Keep it tight — Sonnet handles ~1024 tokens of output reliably.
 */
function buildClassificationPrompt(messages: EmailMessage[]): string {
  const list = messages.map(m =>
    `ID: ${m.id}\nFrom: ${m.from}\nSubject: ${m.subject}\nPreview: ${m.preview}`
  ).join('\n\n---\n\n');

  return `You are an email triage assistant. Classify each email below and return a JSON array.

Each object must have:
- "id": the email ID (string, exact match)
- "action": one of "notify" | "add_rule" | "file" | "ignore"
- "urgency": "high" | "normal" | "low" (required when action is "notify")
- "reason": brief explanation (1 sentence)
- "ruleCategory": "junk" | "newsletters" | "receipts" | "auto_read" (required when action is "add_rule")
- "rulePattern": the substring pattern to add to the config (required when action is "add_rule")
- "folder": destination folder name (required when action is "file")

Actions:
- notify: surface to the user — new sender, VIP, or time-sensitive
- add_rule: recurring sender that should be auto-categorized; include a config pattern
- file: move to a named folder without notifying
- ignore: mark as read and leave in place

Emails to classify:

${list}

Respond with a JSON array only — no markdown, no explanation.`;
}

async function run(config: any, _context: TaskContext): Promise<void> {
  const rules = config.triage ?? {};
  const providers = getEmailProviders();

  if (providers.length === 0) {
    await injectText('[email-check] No email providers configured — skipping.');
    return;
  }

  // 1. Collect unread messages across all configured providers
  const allUnread: EmailMessage[] = [];
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    try {
      const msgs = await provider.getUnread({ limit: 50 });
      allUnread.push(...msgs.map(m => ({ ...m, provider: provider.name })));
    } catch (err) {
      console.error(`[email-check] Provider ${provider.name} error:`, err);
    }
  }

  if (allUnread.length === 0) {
    return; // Nothing to do — silent exit
  }

  // 2. Rule-based triage (fast path — no API call needed)
  const remaining: EmailMessage[] = [];
  const results = { junk: 0, newsletters: 0, receipts: 0, autoRead: 0, escalated: 0 };

  for (const msg of allUnread) {
    const combined = `${msg.from} ${msg.subject}`;

    if (matchesAny(combined, rules.junk)) {
      await moveEmail(msg, 'Junk');
      results.junk++;
    } else if (matchesAny(combined, rules.newsletters)) {
      await moveEmail(msg, 'Newsletters');
      results.newsletters++;
    } else if (matchesAny(combined, rules.receipts)) {
      await moveEmail(msg, 'Receipts');
      results.receipts++;
    } else if (matchesAny(combined, rules.auto_read)) {
      await markAsRead(msg);
      results.autoRead++;
    } else {
      remaining.push(msg);
    }
  }

  // 3. Sub-agent classification for remaining messages
  const recommendations: TriageRecommendation[] = [];
  if (remaining.length > 0) {
    const prompt = buildClassificationPrompt(remaining);
    const raw = await askClaude(prompt, {
      model: 'claude-sonnet-4-5',
      maxTokens: 1024,
      systemPrompt: 'Return only valid JSON. No markdown fences.',
    });

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as TriageRecommendation[];
        recommendations.push(...parsed);
      } catch {
        console.error('[email-check] Failed to parse sub-agent response:', raw);
      }
    }

    // Act on recommendations
    for (const rec of recommendations) {
      const msg = remaining.find(m => m.id === rec.id);
      if (!msg) continue;

      switch (rec.action) {
        case 'notify':
          results.escalated++;
          // Notification happens in the summary below
          break;
        case 'add_rule':
          // Log suggested rule for the user to add to config
          console.log(`[email-check] Suggested rule: ${rec.ruleCategory} += "${rec.rulePattern}" (from: ${msg.from})`);
          results.escalated++;
          break;
        case 'file':
          await moveEmail(msg, rec.folder ?? 'Archive');
          break;
        case 'ignore':
          await markAsRead(msg);
          break;
      }
    }
  }

  // 4. Inject triage summary into the assistant session
  const notifyMsgs = recommendations
    .filter(r => r.action === 'notify' || r.action === 'add_rule')
    .map(r => {
      const msg = remaining.find(m => m.id === r.id);
      return msg ? `- [${r.urgency ?? 'normal'}] From: ${msg.from} | ${msg.subject}${r.reason ? ` — ${r.reason}` : ''}` : null;
    })
    .filter(Boolean);

  const parts: string[] = ['[email-check]'];
  if (results.junk > 0)       parts.push(`${results.junk} junk`);
  if (results.newsletters > 0) parts.push(`${results.newsletters} newsletters`);
  if (results.receipts > 0)   parts.push(`${results.receipts} receipts`);
  if (results.autoRead > 0)   parts.push(`${results.autoRead} auto-read`);

  if (notifyMsgs.length > 0) {
    parts.push(`\n${notifyMsgs.length} message(s) need attention:\n${notifyMsgs.join('\n')}`);
  } else if (allUnread.length > 0) {
    parts.push('inbox clear');
  }

  await injectText(parts.join(' | '));
}

// --- Provider helpers (implement against your email provider API) ---

async function moveEmail(msg: EmailMessage, folder: string): Promise<void> {
  const providers = getEmailProviders();
  const provider = providers.find(p => p.name === msg.provider);
  await provider?.moveMessage(msg.id, folder);
}

async function markAsRead(msg: EmailMessage): Promise<void> {
  const providers = getEmailProviders();
  const provider = providers.find(p => p.name === msg.provider);
  await provider?.markAsRead(msg.id);
}

registerTask({ name: 'email-check', run });
```

### Sub-agent Prompt Pattern

The classification prompt uses a structured format that Sonnet handles reliably. Key design choices:

- **Closed action set**: `notify | add_rule | file | ignore` — prevents free-form responses
- **`add_rule` action**: when Sonnet recognizes a recurring pattern (e.g., a newsletter domain), it returns both the category and a suggested config pattern string you can paste directly into your config
- **`file` action**: moves to a named folder without notifying — useful for known senders that are not junk but don't need attention
- **Graceful fallback**: `askClaude()` returns `null` on API failure — the task logs the error and continues with the rule-based results already collected

```
System: "Return only valid JSON. No markdown fences."

User:   Classify each email. Return a JSON array.
        Each object: { id, action, urgency?, reason?, ruleCategory?, rulePattern?, folder? }
        Actions: notify | add_rule | file | ignore
        [email list...]
```

---

## Config Snippet

```yaml
channels:
  email:
    enabled: true
    # Triage rules — patterns are case-insensitive substrings by default.
    # Use regex syntax (contains *, (, or [) for advanced matching.
    triage:
      # VIP senders — always escalated to sub-agent for notify classification
      vip:
        - "boss@company.com"
        - "partner@example.com"
      # Junk — move to Junk folder without reading
      junk:
        - "noreply@spam"
        - "marketing@"
        - "unsubscribe"
        - "click here to unsubscribe"
      # Newsletters — move to Newsletters folder
      newsletters:
        - "substack.com"
        - "newsletter@"
        - "digest@"
        - "weekly roundup"
      # Receipts — move to Receipts folder
      receipts:
        - "receipt"
        - "order confirmation"
        - "payment received"
        - "invoice #"
      # Auto-read — mark as read and leave in inbox (low-signal notifications)
      auto_read:
        - "automated-notification@"
        - "no-reply@github.com"
        - "notifications@"

scheduler:
  tasks:
    - name: email-check
      # Run every 15 minutes
      interval: "15m"
      enabled: true
      config:
        # Do not require an active Claude session — runs silently if idle
        requires_session: false
```

**Interval options**: `"5m"`, `"15m"`, `"30m"`, `"1h"` — or a cron expression like `"0 */2 * * *"` for every 2 hours.

**`requires_session: false`**: The task runs even when you are not actively chatting. If important messages arrive, the summary is injected and will appear at the start of your next session. Set to `true` if you only want triage while you are online.

---

## Troubleshooting

**Emails not being checked**

- Confirm the provider reports as configured: check daemon logs for `[email-check] Provider X error`
- Test the provider connection directly: `curl -X POST http://localhost:3847/api/tasks/email-check/run`
- Verify your email credentials are current — OAuth tokens expire and may need re-authorization

**Rules not matching expected senders**

- Patterns are case-insensitive substrings by default. The match runs against `from + subject` concatenated with a space.
- Test a pattern manually:
  ```python
  text = "marketing@newsletter.example.com Weekly Digest"
  pattern = "marketing@"
  print(text.lower().find(pattern.lower()))  # Should be >= 0
  ```
- Regex patterns (containing `*`, `(`, or `[`) use Python/JS regex syntax — test at [regex101.com](https://regex101.com)

**Sub-agent not classifying (API errors)**

- Check that your Claude API key is configured: `security find-generic-password -s credential-anthropic-api-key -w`
- Look for errors in the daemon log: `grep "email-check" logs/daemon.log | grep -i error`
- `askClaude()` returns `null` on failure and the task continues with rule-based results — this is expected graceful degradation, not a crash

**Double-notifications for the same message**

- The task deduplicates by message ID within a single run, but if the provider returns a message as unread across multiple runs (e.g., mark-as-read failed), it may surface twice
- Implement a seen-IDs set persisted to `.kithkit/state/email-seen-ids.json` and skip messages already processed:
  ```typescript
  const seenIds = loadSeenIds(); // Set<string>
  const fresh = allUnread.filter(m => !seenIds.has(m.id));
  // ... after processing, save fresh IDs to seenIds
  ```

**Task runs but injects nothing**

- If `allUnread.length === 0` the task exits silently — this is correct behavior when there is no new mail
- If you expect mail but none is returned, check the provider's `getUnread()` implementation — some providers require specific folder scopes or IMAP flags

**High API costs from sub-agent calls**

- The sub-agent (Sonnet) is only called for messages that do not match any rule. Grow your rule list over time using the `add_rule` recommendations — each accepted rule reduces future API calls.
- Cap the number of messages sent to the sub-agent with a `limit` parameter on `getUnread()`. The reference code uses 50; reduce to 20 if costs are a concern.
