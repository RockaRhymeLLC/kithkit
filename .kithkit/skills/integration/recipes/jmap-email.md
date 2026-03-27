# JMAP Email Integration (Fastmail)

JMAP (RFC 8620) is a modern JSON-based email protocol that replaces IMAP. A single HTTP endpoint accepts batched method calls and returns batched responses, making it far more efficient than IMAP's connection-per-session model.

## Protocol Overview

```
Client                          JMAP Server
  |                                 |
  |  POST /jmap/api                 |
  |  { "using": [...],              |
  |    "methodCalls": [             |
  |      ["Email/query", {...}, "0"],|
  |      ["Email/get",   {...}, "1"] |
  |    ] }                          |
  |  -----------------------------> |
  |                                 |
  |  { "methodResponses": [         |
  |      ["Email/query", {...}, "0"],|
  |      ["Email/get",   {...}, "1"] |
  |    ] }                          |
  |  <----------------------------- |
```

One round-trip fetches email IDs and full message content together.

---

## Prerequisites

- Fastmail account (or any RFC 8620-compliant JMAP server)
- Fastmail API token with Mail read/write scope
- Node.js 22+ with `node-fetch` available

---

## Setup

### 1. Generate API Token

In Fastmail: Settings > Privacy & Security > Connected Apps > New API token.
Scopes needed: `urn:ietf:params:jmap:mail` (read + write).

### 2. Store Token in Keychain

```bash
security add-generic-password \
  -s credential-jmap-api-token \
  -a bmo \
  -w "<your-token-here>"
```

Retrieve at runtime:

```bash
security find-generic-password -s credential-jmap-api-token -w
```

### 3. Discover Session URL

Fastmail's well-known URL: `https://api.fastmail.com/.well-known/jmap`

```bash
curl -s -H "Authorization: Bearer $(security find-generic-password -s credential-jmap-api-token -w)" \
  https://api.fastmail.com/.well-known/jmap | jq '{apiUrl, primaryAccounts}'
```

The response includes `apiUrl` (where you POST all calls) and your `accountId`.

---

## Config Snippet

```yaml
email:
  provider:
    type: jmap
    session_url: https://api.fastmail.com/.well-known/jmap
    credential_name: credential-jmap-api-token
    # Optional overrides
    default_mailbox: Inbox
    sent_mailbox: Sent
    trash_mailbox: Trash
```

---

## Reference Code

### JmapEmailProvider — Core Structure

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
}

interface JmapConfig {
  sessionUrl: string;
  credentialName: string;
}

export class JmapEmailProvider {
  private session: JmapSession | null = null;
  private sessionFetchedAt: number = 0;
  private readonly SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(private config: JmapConfig) {}

  // Session discovery with TTL-based cache
  private async getSession(): Promise<JmapSession> {
    const now = Date.now();
    if (this.session && now - this.sessionFetchedAt < this.SESSION_TTL_MS) {
      return this.session;
    }

    const token = await this.getToken();
    const { stdout } = await execFileAsync('curl', [
      '-sf',
      '-H', `Authorization: Bearer ${token}`,
      this.config.sessionUrl,
    ]);

    this.session = JSON.parse(stdout) as JmapSession;
    this.sessionFetchedAt = now;
    return this.session;
  }

  private async getToken(): Promise<string> {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s', this.config.credentialName,
      '-w',
    ]);
    return stdout.trim();
  }

  private getAccountId(session: JmapSession): string {
    const id = session.primaryAccounts['urn:ietf:params:jmap:mail'];
    if (!id) throw new Error('No JMAP mail account found in session');
    return id;
  }

  // POST a batch of method calls
  private async call(methodCalls: unknown[][]): Promise<unknown[][]> {
    const session = await this.getSession();
    const accountId = this.getAccountId(session);
    const token = await this.getToken();

    const body = JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    });

    const { stdout } = await execFileAsync('curl', [
      '-sf',
      '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '-d', body,
      session.apiUrl,
    ]);

    const response = JSON.parse(stdout) as { methodResponses: unknown[][] };
    return response.methodResponses;
  }
```

### resolveMailboxId

```typescript
  private mailboxCache = new Map<string, string>();

  async resolveMailboxId(name: string): Promise<string> {
    if (this.mailboxCache.has(name)) return this.mailboxCache.get(name)!;

    const session = await this.getSession();
    const accountId = this.getAccountId(session);

    const responses = await this.call([
      ['Mailbox/get', { accountId, ids: null }, '0'],
    ]);

    const [, result] = responses[0] as [string, { list: Array<{ id: string; name: string }> }];
    for (const box of result.list) {
      this.mailboxCache.set(box.name, box.id);
    }

    const id = this.mailboxCache.get(name);
    if (!id) throw new Error(`Mailbox not found: ${name}`);
    return id;
  }
```

### Batched Email/query + Email/get

```typescript
  async fetchUnread(mailboxName: string = 'Inbox', limit: number = 20) {
    const session = await this.getSession();
    const accountId = this.getAccountId(session);
    const mailboxId = await this.resolveMailboxId(mailboxName);

    // Single round-trip: query IDs then get full messages
    const responses = await this.call([
      ['Email/query', {
        accountId,
        filter: { inMailbox: mailboxId, notKeyword: '$seen' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, '0'],
      ['Email/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'subject', 'from', 'receivedAt', 'preview', 'keywords', 'mailboxIds'],
      }, '1'],
    ]);

    const [, getResult] = responses[1] as [string, { list: EmailMessage[] }];
    return getResult.list;
  }
```

### Email/set — markAsRead, moveEmail

```typescript
  async markAsRead(emailId: string): Promise<void> {
    const session = await this.getSession();
    const accountId = this.getAccountId(session);

    await this.call([
      ['Email/set', {
        accountId,
        update: {
          [emailId]: { 'keywords/$seen': true },
        },
      }, '0'],
    ]);
  }

  async moveEmail(emailId: string, destMailboxName: string): Promise<void> {
    const session = await this.getSession();
    const accountId = this.getAccountId(session);
    const destId = await this.resolveMailboxId(destMailboxName);

    // Get current mailboxIds first
    const getResp = await this.call([
      ['Email/get', { accountId, ids: [emailId], properties: ['mailboxIds'] }, '0'],
    ]);
    const [, getResult] = getResp[0] as [string, { list: Array<{ mailboxIds: Record<string, boolean> }> }];
    const currentMailboxIds = getResult.list[0]?.mailboxIds ?? {};

    // Replace all mailbox memberships with destination
    const newMailboxIds = Object.fromEntries(
      Object.keys(currentMailboxIds).map(k => [k, null])
    );
    newMailboxIds[destId] = true;

    await this.call([
      ['Email/set', {
        accountId,
        update: { [emailId]: { mailboxIds: newMailboxIds } },
      }, '0'],
    ]);
  }
```

### sendEmail via Email/set create + EmailSubmission/set

```typescript
  async sendEmail(opts: {
    to: string;
    subject: string;
    textBody: string;
    fromAddress?: string;
  }): Promise<void> {
    const session = await this.getSession();
    const accountId = this.getAccountId(session);
    const draftId = await this.resolveMailboxId('Drafts');

    const now = new Date().toISOString();
    const bodyPartId = 'body-text';

    await this.call([
      // Step 1: create the Email object
      ['Email/set', {
        accountId,
        create: {
          draft1: {
            from: [{ email: opts.fromAddress ?? 'me@fastmail.com' }],
            to: [{ email: opts.to }],
            subject: opts.subject,
            keywords: { $draft: true },
            mailboxIds: { [draftId]: true },
            bodyStructure: { partId: bodyPartId, type: 'text/plain' },
            bodyValues: { [bodyPartId]: { value: opts.textBody } },
          },
        },
      }, '0'],
      // Step 2: submit using created ID
      ['EmailSubmission/set', {
        accountId,
        create: {
          sub1: {
            emailId: '#draft1',
            envelope: {
              mailFrom: { email: opts.fromAddress ?? 'me@fastmail.com' },
              rcptTo: [{ email: opts.to }],
            },
          },
        },
        onSuccessDestroyEmail: ['#sub1'],
      }, '1'],
    ]);
  }
}
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` on session fetch | Token missing or revoked | Re-run `security find-generic-password` to verify; regenerate token in Fastmail settings |
| `404` or `503` on session URL | Wrong `session_url` in config | Confirm URL is `https://api.fastmail.com/.well-known/jmap` for Fastmail |
| `Email/set` returns `notFound` error | Email ID stale or already moved | Re-query `Email/query` to get fresh IDs |
| Mailbox ID resolution fails | Mailbox name doesn't match server name exactly | Log `Mailbox/get` response; names are case-sensitive and locale-specific |
| Session cache returns stale `apiUrl` | Server rotated URL (rare) | Call `invalidateSession()` or reduce `SESSION_TTL_MS`; force re-fetch on `4xx` |
| Batched call only returns first response | Server-side method limit hit | Split into smaller batches; JMAP servers may cap `methodCalls` length |
| `EmailSubmission/set` fails silently | SMTP submission quota or identity mismatch | Check `notCreated` map in the response; verify `envelope.mailFrom` matches an identity |
