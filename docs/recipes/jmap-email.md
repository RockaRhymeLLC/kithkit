# Recipe: JMAP Email Integration (Fastmail)

Connect your Kithkit agent to a JMAP-compatible mailbox. JMAP (JSON Meta Application Protocol, [RFC 8620](https://tools.ietf.org/html/rfc8620)) is a modern, efficient alternative to IMAP that uses a single authenticated HTTP connection and supports batched multi-method calls.

[Fastmail](https://www.fastmail.com) is the most common JMAP provider, but any RFC 8620-compliant server works (Stalwart Mail Server, Cyrus IMAP, etc.).

---

## Prerequisites

- A Fastmail account (or any RFC 8620-compliant JMAP server)
- A Fastmail API token (see Step 1)
- Node.js 18+ (daemon runtime)
- The Kithkit daemon configured and running

---

## Setup Steps

### Step 1 — Generate a Fastmail API token

1. Log in to [app.fastmail.com](https://app.fastmail.com)
2. Go to **Settings** → **Privacy & Security** → **API Tokens**
3. Click **New API Token**
4. Give it a name (e.g., `kithkit-daemon`)
5. Select scopes: **Email: Full Access** (read, send, move, flag)
6. Click **Generate Token** and copy the value — it will not be shown again

For other JMAP providers, consult their documentation for API token generation.

### Step 2 — Store the token in Keychain

```bash
security add-generic-password \
  -s credential-jmap-api-token \
  -a kithkit \
  -w "YOUR_API_TOKEN_HERE"
```

Verify:

```bash
security find-generic-password -s credential-jmap-api-token -w
```

### Step 3 — Discover your JMAP session URL

JMAP uses a well-known discovery endpoint. For Fastmail:

```bash
TOKEN=$(security find-generic-password -s credential-jmap-api-token -w)

curl -s -H "Authorization: Bearer ${TOKEN}" \
  https://api.fastmail.com/jmap/session \
  | jq '{apiUrl: .apiUrl, primaryAccounts: .primaryAccounts}'
```

You'll get back something like:

```json
{
  "apiUrl": "https://api.fastmail.com/jmap/api/",
  "primaryAccounts": {
    "urn:ietf:params:jmap:mail": "u12345678"
  }
}
```

Note the `apiUrl` and your account ID. The provider discovers these automatically at startup, but it's useful to verify them manually.

### Step 4 — Configure the Kithkit daemon

See the Config Snippet below, then restart the daemon.

---

## Config Snippet

```yaml
channels:
  email:
    enabled: true
    providers:
      - type: "jmap"
        session_url: "https://api.fastmail.com/jmap/session"
        # Keychain key (default shown — override if using a different name)
        keychain:
          api_token: "credential-jmap-api-token"
        # Optional tuning
        max_list_results: 25
```

For non-Fastmail JMAP servers, replace `session_url` with your provider's well-known URL (e.g., `https://mail.yourcompany.com/.well-known/jmap`).

---

## Reference Code

### EmailProvider interface

All Kithkit email providers implement this shared interface. The JMAP provider is one implementation; Graph, Himalaya, and Outlook IMAP are others. Providers are registered in `channels.email.providers` and selected by the daemon at runtime.

```typescript
export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  date: string;         // ISO 8601
  body: string;         // plain text
  bodyHtml?: string;
  isRead: boolean;
  folder?: string;
}

export interface SendOptions {
  cc?: string[];
  bcc?: string[];
  replyToId?: string;
  isHtml?: boolean;
}

export interface EmailProvider {
  name: string;
  isConfigured(): boolean;
  listInbox(limit?: number, unreadOnly?: boolean): Promise<EmailMessage[]>;
  readEmail(id: string): Promise<EmailMessage | null>;
  markAsRead(id: string): Promise<void>;
  moveEmail?(id: string, folder: string): Promise<void>;
  searchEmails(query: string, limit?: number): Promise<EmailMessage[]>;
  sendEmail(
    to: string,
    subject: string,
    body: string,
    options?: SendOptions
  ): Promise<void>;
}
```

### JMAP protocol basics

JMAP is a single-endpoint protocol. All operations are HTTP POST requests to the `apiUrl` with a JSON body containing one or more method calls. Results are returned in a single response.

```
Client                          JMAP Server
  │                                  │
  │── POST /jmap/api/ ──────────────▶│
  │   Authorization: Bearer {token}  │
  │   {                              │
  │     "using": ["urn:...mail"],    │
  │     "methodCalls": [             │
  │       ["Email/query", {...}, "0"]│  ← method name, args, call ID
  │       ["Email/get", {...}, "1"]  │
  │     ]                            │
  │   }                              │
  │                                  │
  │◀── 200 OK ───────────────────────│
  │   {                              │
  │     "methodResponses": [         │
  │       ["Email/query", {...}, "0"]│
  │       ["Email/get", {...}, "1"]  │
  │     ]                            │
  │   }                              │
```

### JMAP session discovery

```typescript
interface JmapSession {
  apiUrl: string;
  accountId: string;
  inboxId?: string; // resolved mailbox ID for INBOX
}

async function discoverSession(
  sessionUrl: string,
  token: string
): Promise<JmapSession> {
  const res = await fetch(sessionUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`JMAP session discovery failed: ${res.status}`);
  }

  const session = (await res.json()) as any;
  const apiUrl: string = session.apiUrl;
  const accountId: string =
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.values(session.accounts ?? {})[0];

  return { apiUrl, accountId };
}
```

### JMAP provider implementation

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { EmailProvider, EmailMessage, SendOptions } from "./types.js";

const execFileAsync = promisify(execFile);

export class JmapEmailProvider implements EmailProvider {
  name = "jmap";

  private sessionCache: {
    apiUrl: string;
    accountId: string;
    inboxId: string;
  } | null = null;

  constructor(
    private sessionUrl: string,
    private keychainToken: string = "credential-jmap-api-token"
  ) {}

  isConfigured(): boolean {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("security", [
        "find-generic-password",
        "-s", this.keychainToken,
      ], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private async getToken(): Promise<string> {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", this.keychainToken,
      "-w",
    ]);
    return stdout.trim();
  }

  private async getSession(): Promise<typeof this.sessionCache & {}> {
    if (this.sessionCache) return this.sessionCache;

    const token = await this.getToken();
    const res = await fetch(this.sessionUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`JMAP session discovery failed: ${res.status}`);

    const session = (await res.json()) as any;
    const apiUrl: string = session.apiUrl;
    const accountId: string =
      session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
      Object.values(session.accounts ?? {})[0];

    // Resolve INBOX mailbox ID
    const inboxId = await this.resolveMailboxId(apiUrl, accountId, token, "INBOX");

    this.sessionCache = { apiUrl, accountId, inboxId };
    return this.sessionCache;
  }

  private async resolveMailboxId(
    apiUrl: string,
    accountId: string,
    token: string,
    role: string
  ): Promise<string> {
    const res = await this.call(apiUrl, token, [
      [
        "Mailbox/query",
        { accountId, filter: { role: role.toLowerCase() } },
        "0",
      ],
    ]);
    const ids: string[] = res.methodResponses[0][1].ids ?? [];
    if (!ids.length) throw new Error(`JMAP mailbox not found: ${role}`);
    return ids[0];
  }

  private async call(
    apiUrl: string,
    token: string,
    methodCalls: any[]
  ): Promise<any> {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`JMAP API call failed: ${res.status} ${err}`);
    }

    return res.json();
  }

  async listInbox(limit = 25, unreadOnly = false): Promise<EmailMessage[]> {
    const token = await this.getToken();
    const { apiUrl, accountId, inboxId } = await this.getSession();

    const filter: any = { inMailbox: inboxId };
    if (unreadOnly) filter.notKeyword = "$seen";

    // Batch: query for IDs, then fetch email properties
    const result = await this.call(apiUrl, token, [
      [
        "Email/query",
        {
          accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        },
        "q0",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "q0",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id", "subject", "from", "to", "receivedAt",
            "textBody", "htmlBody", "keywords", "mailboxIds",
          ],
        },
        "g0",
      ],
    ]);

    const emails: any[] = result.methodResponses[1][1].list ?? [];
    return emails.map(mapEmail);
  }

  async readEmail(id: string): Promise<EmailMessage | null> {
    const token = await this.getToken();
    const { apiUrl, accountId } = await this.getSession();

    const result = await this.call(apiUrl, token, [
      [
        "Email/get",
        {
          accountId,
          ids: [id],
          properties: [
            "id", "subject", "from", "to", "receivedAt",
            "bodyValues", "textBody", "htmlBody", "keywords",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        "g0",
      ],
    ]);

    const list: any[] = result.methodResponses[0][1].list ?? [];
    if (!list.length) return null;
    return mapEmail(list[0]);
  }

  async markAsRead(id: string): Promise<void> {
    const token = await this.getToken();
    const { apiUrl, accountId } = await this.getSession();

    await this.call(apiUrl, token, [
      [
        "Email/set",
        {
          accountId,
          update: {
            [id]: { "keywords/$seen": true },
          },
        },
        "s0",
      ],
    ]);
  }

  async moveEmail(id: string, targetMailboxId: string): Promise<void> {
    const token = await this.getToken();
    const { apiUrl, accountId, inboxId } = await this.getSession();

    await this.call(apiUrl, token, [
      [
        "Email/set",
        {
          accountId,
          update: {
            [id]: {
              mailboxIds: { [targetMailboxId]: true },
            },
          },
        },
        "s0",
      ],
    ]);
  }

  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    const token = await this.getToken();
    const { apiUrl, accountId } = await this.getSession();

    const result = await this.call(apiUrl, token, [
      [
        "Email/query",
        {
          accountId,
          filter: { text: query },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit,
        },
        "q0",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "q0",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id", "subject", "from", "to", "receivedAt",
            "textBody", "keywords",
          ],
        },
        "g0",
      ],
    ]);

    const emails: any[] = result.methodResponses[1][1].list ?? [];
    return emails.map(mapEmail);
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {}
  ): Promise<void> {
    const token = await this.getToken();
    const { apiUrl, accountId } = await this.getSession();

    // Step 1: Create a draft (Email/set create)
    // Step 2: Submit it (EmailSubmission/set)
    const bodyPart = options.isHtml
      ? { type: "text/html; charset=utf-8", value: body }
      : { type: "text/plain; charset=utf-8", value: body };

    const toAddresses = [{ email: to }];
    const ccAddresses = (options.cc ?? []).map((e) => ({ email: e }));

    const result = await this.call(apiUrl, token, [
      [
        "Email/set",
        {
          accountId,
          create: {
            draft: {
              from: [{ email: "" }],  // server fills from account identity
              to: toAddresses,
              cc: ccAddresses.length ? ccAddresses : undefined,
              subject,
              textBody: options.isHtml ? undefined : [{ partId: "body", type: "text/plain" }],
              htmlBody: options.isHtml ? [{ partId: "body", type: "text/html" }] : undefined,
              bodyValues: { body: bodyPart },
              keywords: { $draft: true },
            },
          },
        },
        "c0",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            send: {
              "#emailId": { resultOf: "c0", name: "Email/set", path: "/created/draft/id" },
              envelope: {
                mailFrom: { email: "" }, // server fills from account identity
                rcptTo: toAddresses,
              },
            },
          },
          onSuccessDestroyEmail: ["#send"],  // clean up draft after sending
        },
        "s0",
      ],
    ]);

    const created = result.methodResponses[0][1]?.created;
    if (!created?.draft) {
      const err = JSON.stringify(result.methodResponses[0][1]?.notCreated ?? {});
      throw new Error(`JMAP sendEmail failed: ${err}`);
    }
  }
}

function mapEmail(raw: any): EmailMessage {
  const fromAddr = raw.from?.[0]?.email ?? raw.from?.[0]?.name ?? "";
  const toAddrs = (raw.to ?? []).map((a: any) => a.email ?? "");
  const seen = "$seen" in (raw.keywords ?? {});

  // Body values may be inline or in bodyValues map
  const textBody = raw.bodyValues
    ? Object.values(raw.bodyValues).find((v: any) => v.type?.startsWith("text/plain"))
    : null;
  const htmlBody = raw.bodyValues
    ? Object.values(raw.bodyValues).find((v: any) => v.type?.startsWith("text/html"))
    : null;

  return {
    id: raw.id,
    subject: raw.subject ?? "(no subject)",
    from: fromAddr,
    to: toAddrs,
    date: raw.receivedAt ?? "",
    body: (textBody as any)?.value ?? (htmlBody as any)?.value ?? "",
    bodyHtml: (htmlBody as any)?.value,
    isRead: seen,
  };
}
```

---

## Troubleshooting

**`401 Unauthorized` on session discovery**

- The API token may be expired or revoked
- Generate a new token in Fastmail Settings → Privacy & Security → API Tokens
- Update Keychain: `security delete-generic-password -s credential-jmap-api-token && security add-generic-password -s credential-jmap-api-token -a kithkit -w "NEW_TOKEN"`

**`404` or `503` on the session URL**

- Verify the `session_url` in your config is correct
- For Fastmail, it is `https://api.fastmail.com/jmap/session`
- For self-hosted JMAP servers, try the well-known path: `https://yourserver.com/.well-known/jmap`
- Test manually: `curl -H "Authorization: Bearer $(security find-generic-password -s credential-jmap-api-token -w)" https://api.fastmail.com/jmap/session | jq .`

**`Email/set` errors on send**

- Check `notCreated` in the response — JMAP returns per-object error details
- Common error: `invalidProperties` — means a required field is missing or malformed
- Fastmail requires `from` to match a verified identity on the account; if left blank, it fills automatically, but some configurations require an explicit address

**`moveEmail` not moving**

- The `targetMailboxId` must be a JMAP mailbox ID (a string like `MBX123`), not a display name like "Archive"
- Use `Mailbox/query` to look up mailbox IDs by name:
  ```typescript
  const result = await this.call(apiUrl, token, [
    ["Mailbox/query", { accountId, filter: { name: "Archive" } }, "0"],
  ]);
  const id = result.methodResponses[0][1].ids[0];
  ```

**Session cache stale after server restart**

- The `sessionCache` is in-memory and reset with the daemon
- If the server rotates account IDs (rare but possible on upgrades), restart the daemon to re-discover the session

**Large batches timing out**

- JMAP allows batching many method calls, but servers impose limits (Fastmail: 16 method calls per request)
- Split large operations across multiple requests if you hit HTTP 400 with `requestTooLarge`
