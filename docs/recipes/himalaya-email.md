# Recipe: Himalaya CLI Email Integration

Connect your Kithkit agent to any IMAP-compatible mailbox using [Himalaya](https://github.com/soywod/himalaya), a cross-platform CLI email client. This is the simplest email integration for Kithkit — no Azure apps, no OAuth dance. Just configure Himalaya with your IMAP credentials and point the daemon at it.

Himalaya supports Gmail, Fastmail, iCloud, Yahoo, generic IMAP providers, and more. Multi-account setups work out of the box.

---

## Prerequisites

- Himalaya CLI installed (see Step 1)
- An IMAP-compatible email account with credentials
- For Gmail: an App Password (not your main password — see Step 2)
- Node.js 22+ (daemon runtime)
- The Kithkit daemon configured and running

---

## Setup Steps

### Step 1 — Install Himalaya

```bash
brew install himalaya
```

Verify:

```bash
himalaya --version
# himalaya 1.x.x
```

### Step 2 — Configure your account(s)

Himalaya uses a TOML config at `~/.config/himalaya/config.toml`. Create or edit it:

**Gmail example:**

Gmail requires an App Password if 2FA is enabled (which it should be).

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Generate a password for "Mail" / "Mac" (or any label)
3. Copy the 16-character password

```toml
# ~/.config/himalaya/config.toml

[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption.type = "tls"
backend.auth.type = "password"
backend.auth.raw = "your-app-password-here"   # or use keyring (see below)

sender.type = "smtp"
sender.host = "smtp.gmail.com"
sender.port = 587
sender.encryption.type = "tls"
sender.auth.type = "password"
sender.auth.raw = "your-app-password-here"
```

**Generic IMAP example:**

```toml
[accounts.work]
email = "agent@yourcompany.com"
display-name = "Assistant"
backend.type = "imap"
backend.host = "mail.yourcompany.com"
backend.port = 993
backend.encryption.type = "tls"
backend.auth.type = "password"
backend.auth.raw = "your-password-here"

sender.type = "smtp"
sender.host = "smtp.yourcompany.com"
sender.port = 587
sender.encryption.type = "tls"
sender.auth.type = "password"
sender.auth.raw = "your-password-here"
```

**Using macOS Keychain for credentials (recommended):**

Instead of `raw`, use `keyring` to pull from macOS Keychain:

```toml
backend.auth.type = "password"
backend.auth.keyring = "himalaya:imap:you@gmail.com"
```

Then store the password:

```bash
security add-generic-password \
  -s "himalaya:imap:you@gmail.com" \
  -a himalaya \
  -w "your-app-password-here"
```

### Step 3 — Test the Himalaya connection

```bash
# List accounts
himalaya account list

# List inbox
himalaya -o json envelope list -a gmail

# Read an email by ID (get IDs from envelope list)
himalaya -o json message read -a gmail 12345

# Send a test email
himalaya message send -a gmail <<EOF
From: you@gmail.com
To: test@example.com
Subject: Himalaya test

Hello from Kithkit!
EOF
```

### Step 4 — Configure the Kithkit daemon

See the Config Snippet below, then restart the daemon.

---

## Config Snippet

```yaml
channels:
  email:
    enabled: true
    providers:
      - type: "himalaya"
        account: "gmail"          # Must match the [accounts.X] name in himalaya config
        # For multi-account setups, add additional entries:
      - type: "himalaya"
        account: "work"
    # Providers are tried in order; the first enabled/configured one is used
    # for outbound unless overridden per-send
```

---

## Reference Code

### EmailProvider interface

All Kithkit email providers implement this shared interface. The Himalaya provider shells out to the `himalaya` CLI and parses JSON output. Providers are registered in `channels.email.providers` and selected by the daemon at runtime.

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

### Himalaya provider implementation

```typescript
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "util";
import type { EmailProvider, EmailMessage, SendOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Run a himalaya command and return parsed JSON.
 *
 * Himalaya (and its underlying imap_codec library) writes warnings and debug
 * info to stdout mixed with the JSON payload. We filter those lines before
 * parsing. Only lines that start with '{' or '[' are treated as JSON.
 */
async function himalaya(args: string[]): Promise<any> {
  const { stdout, stderr } = await execFileAsync("himalaya", ["-o", "json", ...args]);

  // Filter out non-JSON lines (WARN, INFO, etc. from imap_codec)
  const jsonLines = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{") || line.trim().startsWith("["));

  if (jsonLines.length === 0) {
    // Nothing to parse — may be a void operation (markAsRead, move)
    return null;
  }

  // Join and parse — some versions emit multi-line JSON
  return JSON.parse(jsonLines.join(""));
}

export class HimalayaEmailProvider implements EmailProvider {
  name = "himalaya";

  constructor(private account: string) {}

  isConfigured(): boolean {
    try {
      // Synchronous check — just see if himalaya is in PATH
      execFileSync("himalaya", ["account", "list"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  async listInbox(limit = 25, unreadOnly = false): Promise<EmailMessage[]> {
    const args = ["envelope", "list", "-a", this.account, "--max-width", "0"];
    if (limit) args.push("-p", "1", "-s", String(limit));

    const raw = await himalaya(args);
    if (!Array.isArray(raw)) return [];

    let messages = raw.map(mapEnvelope);

    if (unreadOnly) {
      messages = messages.filter((m) => !m.isRead);
    }

    return messages;
  }

  async readEmail(id: string): Promise<EmailMessage | null> {
    try {
      const raw = await himalaya(["message", "read", "-a", this.account, id]);
      if (!raw) return null;
      return mapMessage(id, raw);
    } catch {
      return null;
    }
  }

  async markAsRead(id: string): Promise<void> {
    // Himalaya uses flag commands to mark messages
    await himalaya(["flag", "add", "-a", this.account, id, "Seen"]);
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    // Note: ID format may differ by server — some use UID, some use sequence number
    await himalaya(["message", "move", "-a", this.account, folder, "--", id]);
  }

  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    // Himalaya search uses IMAP SEARCH syntax
    const args = [
      "envelope", "list",
      "-a", this.account,
      "-q", `subject:"${query}"`,
      "-s", String(limit),
    ];
    const raw = await himalaya(args);
    if (!Array.isArray(raw)) return [];
    return raw.map(mapEnvelope);
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {}
  ): Promise<void> {
    // Build RFC 2822-style message
    const headers: string[] = [
      `To: ${to}`,
      `Subject: ${subject}`,
    ];

    if (options.cc?.length) headers.push(`Cc: ${options.cc.join(", ")}`);
    if (options.bcc?.length) headers.push(`Bcc: ${options.bcc.join(", ")}`);
    if (options.isHtml) headers.push("Content-Type: text/html; charset=utf-8");

    const raw = [...headers, "", body].join("\n");

    // Pipe raw message to himalaya's send command
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "himalaya",
        ["message", "send", "-a", this.account],
        (err) => (err ? reject(err) : resolve())
      );
      child.stdin?.write(raw);
      child.stdin?.end();
    });
  }
}

// Map a himalaya envelope (list view) to EmailMessage
function mapEnvelope(raw: any): EmailMessage {
  return {
    id: String(raw.id ?? raw.uid ?? ""),
    subject: raw.subject ?? "(no subject)",
    from: raw.from?.addr ?? raw.sender ?? "",
    to: [],            // not included in envelope list — fetch full message to get To
    date: raw.date ?? "",
    body: "",          // not included in envelope list — fetch full message to get body
    isRead: !(raw.flags ?? []).includes("\\Unseen"),
    folder: "INBOX",
  };
}

// Map a himalaya full message to EmailMessage
function mapMessage(id: string, raw: any): EmailMessage {
  const textPart = raw.body?.find?.((p: any) => p["content-type"] === "text/plain");
  const htmlPart = raw.body?.find?.((p: any) => p["content-type"] === "text/html");

  return {
    id,
    subject: raw.subject ?? "(no subject)",
    from: raw.from?.[0]?.addr ?? "",
    to: (raw.to ?? []).map((t: any) => t.addr),
    date: raw.date ?? "",
    body: textPart?.body ?? htmlPart?.body ?? "",
    bodyHtml: htmlPart?.body,
    isRead: true, // if we fetched it, assume it was already read (or markAsRead will follow)
    folder: raw.folder,
  };
}
```

### Multi-account helper

When multiple Himalaya accounts are configured, the daemon picks the right provider based on account name or falls through to the first configured provider:

```typescript
// In provider registry
const providers: EmailProvider[] = config.channels.email.providers
  .filter((p) => p.type === "himalaya")
  .map((p) => new HimalayaEmailProvider(p.account));

export function getProvider(account?: string): EmailProvider | null {
  if (account) {
    return providers.find((p) => (p as HimalayaEmailProvider).account === account) ?? null;
  }
  return providers[0] ?? null;
}
```

---

## Troubleshooting

**`himalaya: command not found`**

- Run `brew install himalaya` and ensure `/usr/local/bin` or `/opt/homebrew/bin` is in PATH
- Verify: `which himalaya`

**JSON parse errors / `Unexpected token`**

- Himalaya (and the `imap_codec` Rust library underneath) writes diagnostic output — WARN lines, connection info — to stdout alongside JSON
- The provider filters non-JSON lines before parsing; if you see parse errors, enable debug logging and check what raw output himalaya emits: `himalaya -o json envelope list -a gmail 2>&1 | head -40`
- Upgrading Himalaya may change output format — pin the version with `brew pin himalaya` if stability is critical

**Authentication failures**

- Gmail: Make sure you are using an App Password, not your Google account password. Regular passwords are rejected for IMAP when 2FA is enabled
- Check that IMAP access is enabled in Gmail settings: Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP

**`moveEmail` silently fails**

- IMAP message IDs (UIDs vs sequence numbers) behave differently across servers
- If moves fail, try listing the message again after the move to confirm the new folder — some servers reassign UIDs on move
- The `--` separator in the CLI call is required when the ID starts with a dash (defensive, good practice)

**`isConfigured()` returns false**

- The provider runs `himalaya account list` synchronously to check configuration
- Ensure `~/.config/himalaya/config.toml` exists and is valid TOML
- Run `himalaya account list` directly in a terminal to confirm the CLI itself works

**Email appears as read after `readEmail()`**

- IMAP `FETCH` typically marks messages as seen
- Call `markAsRead()` explicitly only when you intend to — or configure Himalaya's `read-headers-cmd` to peek without marking
- Some workflows intentionally read without marking: in that case, call `himalaya flag remove -a {account} {id} Seen` after reading
