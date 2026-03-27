# Himalaya CLI Email Integration

Use the [Himalaya](https://github.com/soywod/himalaya) command-line email client as the simplest path to IMAP access. Works with Gmail (App Password), Outlook, Fastmail, and any standard IMAP provider. No OAuth2 app registration required.

## Prerequisites

- Himalaya CLI installed (see setup step 1)
- An IMAP-capable email account
- For Gmail: [App Password](https://myaccount.google.com/apppasswords) (requires 2FA enabled)
- Kithkit daemon running

## Setup

### 1. Install Himalaya

**macOS (Homebrew):**

```bash
brew install himalaya
```

**Cargo:**

```bash
cargo install himalaya
```

Verify:

```bash
himalaya --version
```

### 2. Configure accounts

Himalaya reads `~/.config/himalaya/config.toml`. Create it:

```toml
# ~/.config/himalaya/config.toml

[accounts.gmail]
default = true
email   = "you@gmail.com"

backend.type       = "imap"
backend.host       = "imap.gmail.com"
backend.port       = 993
backend.encryption = "tls"
backend.login      = "you@gmail.com"
backend.auth.type  = "password"
backend.auth.raw   = "your-app-password"   # or use keyring (see below)

sender.type        = "smtp"
sender.host        = "smtp.gmail.com"
sender.port        = 465
sender.encryption  = "tls"
sender.login       = "you@gmail.com"
sender.auth.type   = "password"
sender.auth.raw    = "your-app-password"
```

**Using system Keychain instead of raw password (recommended):**

```toml
backend.auth.type     = "keyring"
backend.auth.entry    = "himalaya:gmail"    # stored as generic password with service "himalaya:gmail"
```

Store the App Password:

```bash
security add-generic-password -s himalaya:gmail -a bmo -w "<APP_PASSWORD>"
```

### 3. Test the connection

```bash
himalaya envelope list --account gmail
himalaya envelope list --account gmail --folder INBOX --max-count 5
```

### 4. Add a second account (optional)

```toml
[accounts.work]
email = "you@yourcompany.com"

backend.type       = "imap"
backend.host       = "imap.yourcompany.com"
backend.port       = 993
backend.encryption = "tls"
backend.login      = "you@yourcompany.com"
backend.auth.type  = "password"
backend.auth.raw   = "your-password"

sender.type        = "smtp"
sender.host        = "smtp.yourcompany.com"
sender.port        = 587
sender.encryption  = "starttls"
sender.login       = "you@yourcompany.com"
sender.auth.type   = "password"
sender.auth.raw    = "your-password"
```

## Configuration

```yaml
extensions:
  email:
    enabled: true
    provider: himalaya
    himalaya:
      binary: himalaya        # or absolute path if not in PATH
      account: gmail          # matches [accounts.<name>] in himalaya config
      max_results: 25
      # Multi-account: specify per-operation below
      accounts:
        primary: gmail
        work:    work
```

## Key Reference Code

### HimalayaEmailProvider (TypeScript)

```typescript
// providers/himalaya-email-provider.ts
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class HimalayaEmailProvider implements EmailProvider {
  constructor(private readonly cfg: HimalayaConfig) {}

  private get bin(): string { return this.cfg.binary ?? 'himalaya'; }
  private get acct(): string { return this.cfg.account; }

  /**
   * Run himalaya and parse JSON output.
   * Himalaya may emit WARN lines to stdout before the JSON — filter them.
   */
  private async run(args: string[]): Promise<unknown> {
    const fullArgs = ['--account', this.acct, '--output', 'json', ...args];
    const { stdout } = await execFileAsync(this.bin, fullArgs);

    // Strip any leading WARN / INFO lines that himalaya writes before JSON
    const lines = stdout.split('\n');
    const jsonStart = lines.findIndex(l => l.trimStart().startsWith('[') || l.trimStart().startsWith('{'));
    if (jsonStart === -1) throw new Error(`No JSON in himalaya output:\n${stdout}`);
    const jsonText = lines.slice(jsonStart).join('\n');
    return JSON.parse(jsonText);
  }

  async listInbox(options?: { maxResults?: number; unreadOnly?: boolean }): Promise<Email[]> {
    const max = options?.maxResults ?? this.cfg.max_results ?? 25;
    const args = ['envelope', 'list', '--folder', 'INBOX', '--max-count', String(max)];
    const raw = (await this.run(args)) as HimalayaEnvelope[];

    let emails = raw.map(himalayaToEmail);
    if (options?.unreadOnly) {
      emails = emails.filter(e => !e.isRead);
    }
    return emails;
  }

  async readEmail(id: string): Promise<Email> {
    const raw = (await this.run(['message', 'read', id])) as HimalayaMessage;
    return himalayaMessageToEmail(raw);
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    await this.run(['message', 'move', '--folder', folder, id]);
  }

  async searchEmails(query: string): Promise<Email[]> {
    // Himalaya search wraps IMAP SEARCH — checks subject and from by default
    const raw = (await this.run(['envelope', 'list', '--query', query])) as HimalayaEnvelope[];
    return raw.map(himalayaToEmail);
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // Build a minimal RFC 2822 message and pipe it to `himalaya message send`
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.bin, ['--account', this.acct, 'message', 'send'], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      child.stdin.end(raw, 'utf8');
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`himalaya send exited ${code}`)));
    });
  }
}

// --- Mapping helpers ---

function himalayaToEmail(e: HimalayaEnvelope): Email {
  return {
    id:      String(e.id),
    subject: e.subject ?? '(no subject)',
    from:    e.from?.addr ?? '',
    to:      [],
    date:    e.date,
    body:    '',          // envelope list does not include body
    isRead:  e.flags ? !e.flags.includes('Unseen') : true,
  };
}

function himalayaMessageToEmail(m: HimalayaMessage): Email {
  return {
    id:      String(m.id),
    subject: m.subject ?? '(no subject)',
    from:    m.from?.addr ?? '',
    to:      (m.to ?? []).map(r => r.addr),
    date:    m.date,
    body:    m.text_plain ?? m.text_html ?? '',
    isRead:  true,  // reading marks it read
  };
}
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `command not found: himalaya` | Not in PATH or wrong binary path | Use absolute path in config: `binary: /usr/local/bin/himalaya`; verify with `which himalaya` |
| `JSON parse error` | WARN/INFO lines before JSON in stdout | The provider's `run()` method strips leading non-JSON lines — ensure you are using the reference implementation |
| `authentication failed` / `Invalid credentials` | Wrong App Password or Keychain entry name | For Gmail: generate a new App Password at `myaccount.google.com/apppasswords`; for keyring mode confirm service name matches |
| `moveEmail` silently fails | Destination folder name incorrect | List folders with `himalaya folder list --account gmail` to get exact names (e.g., `[Gmail]/All Mail`) |
| No emails returned | Wrong account name in config | Ensure `account:` in `kithkit.config.yaml` matches the key in `~/.config/himalaya/config.toml` |
| Gmail IMAP disabled | IMAP not enabled in Gmail settings | Go to Gmail > Settings > See all settings > Forwarding and POP/IMAP > Enable IMAP |
