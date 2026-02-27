# Periodic Email Triage Task

Automatically triage incoming email on a schedule. Pattern rules handle known senders immediately; a Claude sub-agent classifies anything that doesn't match, choosing from a closed action set to keep costs predictable.

---

## Overview

```
Scheduler fires
    |
    v
fetchUnread() ──> for each email:
    |                 matchesAny(rules) ──yes──> apply action (mark_read / file / notify / ignore)
    |                       |
    |                      no
    |                       v
    |               sub-agent classify(email)
    |                       |
    |                       v
    |               action: notify | add_rule | file | ignore
    v
notify comms if any actionable emails
```

---

## Prerequisites

- Email provider configured (JMAP or IMAP — see companion recipes)
- Daemon running and healthy (`GET /health`)
- `ANTHROPIC_API_KEY` available to the daemon process
- Scheduler enabled in config (`scheduler.enabled: true`)

---

## Setup

### 1. Configure Triage Rules

Add rules to your config (see Config Snippet below). Rules are evaluated top-to-bottom; first match wins.

### 2. Register the Task Handler

Create `daemon/src/automation/tasks/email-triage.ts` (see Reference Code below) and import it in your extension's `onInit`:

```typescript
import { registerEmailTriageTask } from './tasks/email-triage.js';

export async function onInit(daemon: DaemonContext) {
  registerEmailTriageTask(daemon);
}
```

### 3. Enable the Scheduler Task

Add the task entry to your config (see Config Snippet). Then hot-reload:

```bash
curl -s -X POST http://localhost:3847/api/config/reload
```

Verify it appeared:

```bash
curl -s http://localhost:3847/api/tasks | jq '.[] | select(.name=="email-triage")'
```

Trigger manually to test:

```bash
curl -s -X POST http://localhost:3847/api/tasks/email-triage/run
```

---

## Config Snippet

```yaml
email:
  provider:
    type: jmap
    session_url: https://api.fastmail.com/.well-known/jmap
    credential_name: credential-jmap-api-token

  triage:
    rules:
      # VIP senders — always notify comms immediately
      - name: vip
        action: notify
        from_contains:
          - "dave@"
          - "r2@"
          - "boss@example.com"

      # Confirmed junk — mark read, file to Junk, no notification
      - name: junk
        action: mark_read_and_file
        destination: Junk
        subject_contains:
          - "unsubscribe"
          - "DEAL OF THE DAY"
        from_contains:
          - "noreply@promotions."
          - "@marketing."

      # Newsletters — mark read, file, no notification
      - name: newsletters
        action: mark_read_and_file
        destination: Newsletters
        subject_regex:
          - "^\\[.*\\]"            # [List Name] Subject format
        from_contains:
          - "newsletter@"
          - "digest@"

      # Receipts and order confirmations — mark read, file
      - name: receipts
        action: mark_read_and_file
        destination: Receipts
        subject_contains:
          - "Your order"
          - "Receipt from"
          - "Invoice #"
          - "Your receipt"

      # Mark-read-only for known automated senders
      - name: auto_read
        action: mark_read
        from_contains:
          - "no-reply@github.com"
          - "notifications@github.com"

scheduler:
  tasks:
    - name: email-triage
      enabled: true
      interval: 300000    # every 5 minutes (ms)
      config:
        mailbox: Inbox
        limit: 50          # emails per run
        sub_agent_enabled: true
        sub_agent_model: claude-haiku-4-5   # cheap model for classification
        sub_agent_max_tokens: 256
        notify_channel: telegram
```

---

## Reference Code

### matchesAny — Pattern Matcher

```typescript
interface TriageRule {
  name: string;
  action: 'notify' | 'mark_read' | 'mark_read_and_file' | 'ignore';
  destination?: string;      // for mark_read_and_file
  from_contains?: string[];
  subject_contains?: string[];
  subject_regex?: string[];
}

interface EmailSummary {
  id: string;
  subject: string;
  from: Array<{ email: string; name?: string }>;
  preview: string;
  receivedAt: string;
}

function matchesAny(email: EmailSummary, rules: TriageRule[]): TriageRule | null {
  const fromAddrs = email.from.map(f => f.email.toLowerCase());
  const subject = (email.subject ?? '').toLowerCase();

  for (const rule of rules) {
    // from_contains: any sender address substring match
    if (rule.from_contains?.length) {
      const hit = rule.from_contains.some(pattern =>
        fromAddrs.some(addr => addr.includes(pattern.toLowerCase()))
      );
      if (hit) return rule;
    }

    // subject_contains: substring match
    if (rule.subject_contains?.length) {
      const hit = rule.subject_contains.some(pattern =>
        subject.includes(pattern.toLowerCase())
      );
      if (hit) return rule;
    }

    // subject_regex: full regex match
    if (rule.subject_regex?.length) {
      const hit = rule.subject_regex.some(pattern =>
        new RegExp(pattern, 'i').test(email.subject ?? '')
      );
      if (hit) return rule;
    }
  }

  return null;
}
```

### Task Handler

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function registerEmailTriageTask(daemon: DaemonContext) {
  daemon.scheduler.register('email-triage', async (taskConfig) => {
    const cfg = taskConfig as {
      mailbox: string;
      limit: number;
      sub_agent_enabled: boolean;
      sub_agent_model: string;
      sub_agent_max_tokens: number;
      notify_channel: string;
    };

    const provider = daemon.email.getProvider();
    const rules: TriageRule[] = daemon.config.email?.triage?.rules ?? [];
    const emails = await provider.fetchUnread(cfg.mailbox, cfg.limit);

    const notifications: string[] = [];

    for (const email of emails) {
      const rule = matchesAny(email, rules);

      if (rule) {
        await applyRule(provider, email, rule);
        if (rule.action === 'notify') {
          notifications.push(formatNotification(email));
        }
      } else if (cfg.sub_agent_enabled) {
        const action = await classifyWithSubAgent(email, cfg);
        await handleSubAgentAction(provider, daemon, email, action, rules, notifications);
      }
    }

    if (notifications.length > 0) {
      await daemon.send({
        to: 'comms',
        type: 'email-triage-result',
        body: notifications.join('\n\n'),
        channels: [cfg.notify_channel],
      });
    }
  });
}

async function applyRule(
  provider: EmailProvider,
  email: EmailSummary,
  rule: TriageRule
): Promise<void> {
  switch (rule.action) {
    case 'mark_read':
      await provider.markAsRead(email.id);
      break;
    case 'mark_read_and_file':
      await provider.markAsRead(email.id);
      if (rule.destination) await provider.moveEmail(email.id, rule.destination);
      break;
    case 'notify':
      // notification is collected by caller
      break;
    case 'ignore':
    default:
      break;
  }
}

function formatNotification(email: EmailSummary): string {
  const from = email.from[0];
  const sender = from.name ? `${from.name} <${from.email}>` : from.email;
  return `**New email** from ${sender}\nSubject: ${email.subject}\n${email.preview}`;
}
```

### Sub-Agent Classification Prompt

```typescript
const SUB_AGENT_PROMPT = `You are an email triage assistant. Classify this email and return a single JSON object.

Allowed actions (pick exactly one):
- "notify"    — this needs the user's attention (reply expected, important info, time-sensitive)
- "add_rule"  — this is a recurring pattern; suggest a new triage rule to handle it automatically
- "file"      — archive it silently (no reply needed, not urgent)
- "ignore"    — leave it in the inbox unread (uncertain, borderline)

Return ONLY valid JSON, no prose:
{
  "action": "<notify|add_rule|file|ignore>",
  "reason": "<one sentence>",
  "rule"?: {                          // only when action is "add_rule"
    "name": "<short-identifier>",
    "from_contains"?: ["<pattern>"],
    "subject_contains"?: ["<pattern>"],
    "action": "<mark_read|mark_read_and_file|ignore>",
    "destination"?: "<MailboxName>"   // required for mark_read_and_file
  },
  "destination"?: "<MailboxName>"     // for action "file" — defaults to "Archive"
}

Email:
From: {{FROM}}
Subject: {{SUBJECT}}
Preview: {{PREVIEW}}`;

async function classifyWithSubAgent(
  email: EmailSummary,
  cfg: { sub_agent_model: string; sub_agent_max_tokens: number }
): Promise<SubAgentResult> {
  const prompt = SUB_AGENT_PROMPT
    .replace('{{FROM}}', email.from.map(f => `${f.name ?? ''} <${f.email}>`).join(', '))
    .replace('{{SUBJECT}}', email.subject ?? '(no subject)')
    .replace('{{PREVIEW}}', email.preview?.slice(0, 300) ?? '');

  try {
    const { stdout } = await execFileAsync('curl', [
      '-sf',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${process.env.ANTHROPIC_API_KEY}`,
      '-d', JSON.stringify({
        model: cfg.sub_agent_model,
        max_tokens: cfg.sub_agent_max_tokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      'https://api.anthropic.com/v1/messages',
    ]);

    const resp = JSON.parse(stdout);
    const text = resp.content?.[0]?.text ?? '{}';
    return JSON.parse(text) as SubAgentResult;
  } catch {
    // On any parse/API error, default to ignore
    return { action: 'ignore', reason: 'classification failed' };
  }
}

interface SubAgentResult {
  action: 'notify' | 'add_rule' | 'file' | 'ignore';
  reason: string;
  rule?: TriageRule;
  destination?: string;
}

async function handleSubAgentAction(
  provider: EmailProvider,
  daemon: DaemonContext,
  email: EmailSummary,
  result: SubAgentResult,
  rules: TriageRule[],
  notifications: string[]
): Promise<void> {
  switch (result.action) {
    case 'notify':
      notifications.push(formatNotification(email));
      break;

    case 'add_rule':
      if (result.rule) {
        // Persist the new rule via daemon config API
        await daemon.config.appendEmailTriageRule(result.rule);
        // Apply the new rule immediately to this email
        await applyRule(provider, email, result.rule);
        daemon.logger.info('email-triage', `Added rule: ${result.rule.name}`);
      }
      break;

    case 'file':
      await provider.markAsRead(email.id);
      await provider.moveEmail(email.id, result.destination ?? 'Archive');
      break;

    case 'ignore':
    default:
      break;
  }
}
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Emails not being checked | Scheduler task not registered or not enabled | Check `GET /api/tasks`; confirm `email-triage` appears with `enabled: true`. Verify `registerEmailTriageTask()` is called in `onInit`. |
| Rules not matching | Pattern case sensitivity or whitespace | `from_contains` is lowercased before comparison; `subject_regex` uses `i` flag. Log `email.from` and `email.subject` raw to verify. |
| Sub-agent API errors | Missing or invalid `ANTHROPIC_API_KEY` | Confirm env var is set in daemon's launchd plist. Check daemon logs for `curl` stderr. |
| Double notifications | Task fired twice in one interval | Check for duplicate task registrations. Each `scheduler.register(name)` call overwrites the previous, but two `onInit` calls will double-fire. |
| High API costs | Sub-agent classifying too many emails | Expand your rules to catch recurring senders before they hit the sub-agent. Check `GET /api/usage`. Use `claude-haiku-4-5` not Sonnet/Opus for classification. |
| `add_rule` suggestions ignored | `daemon.config.appendEmailTriageRule` not implemented | Wire up a config mutation endpoint or write the rule back to `kithkit.config.yaml` and call `POST /api/config/reload`. |
| Task runs but does nothing | `fetchUnread` returns 0 | Confirm the mailbox name in config matches the server exactly (case-sensitive). Manually call `provider.fetchUnread('Inbox', 5)` in a test script. |
