# Outlook IMAP + OAuth2 Integration

Access an Outlook/Microsoft 365 mailbox over IMAP using OAuth2 (SASL XOAUTH2). This approach is receive-only — use the Graph email provider for sending.

> **IMPORTANT:** This requires a **separate** Azure AD app from the Graph email integration. The two apps use different permission types (delegated vs. application) and different auth flows. Do not reuse the Graph app registration.

## Prerequisites

- Azure portal access (`portal.azure.com`)
- Python 3.9+ with `requests` and `msal` packages
- Kithkit daemon running
- For sending: set up the Graph email provider alongside this one

## Setup

### 1. Register a NEW Azure AD application

1. **Azure Active Directory > App registrations > New registration**
2. Name it differently from your Graph app (e.g., `kithkit-imap-delegated`)
3. Redirect URI: set **Mobile and desktop applications** to `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Note the **Application (client) ID**

### 2. Add delegated permissions

**API permissions > Add a permission > Microsoft Graph > Delegated permissions**:

| Permission | Purpose |
|------------|---------|
| `IMAP.AccessAsUser.All` | IMAP access as the signed-in user |
| `offline_access` | Refresh tokens |
| `User.Read` | Verify identity |

No admin consent is required for delegated permissions — the user grants them during device code flow.

### 3. Enable public client

**Authentication > Advanced settings > Allow public client flows: Yes**. This is required for device code flow.

### 4. Run device code flow to obtain tokens

```bash
python3 -c "
import msal, json

CLIENT_ID = '<YOUR_CLIENT_ID>'
AUTHORITY = 'https://login.microsoftonline.com/common'
SCOPES = ['https://outlook.office.com/IMAP.AccessAsUser.All', 'offline_access']

app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)
flow = app.initiate_device_flow(scopes=SCOPES)
print(flow['message'])  # Instructs you to visit a URL and enter a code

result = app.acquire_token_by_device_flow(flow)
print(json.dumps(result, indent=2))
"
```

Visit the URL printed, authenticate as the mailbox user, and grant consent. The script prints the token response — store the refresh token:

```bash
security add-generic-password -s credential-outlook-imap-client-id      -a bmo -w "<CLIENT_ID>"
security add-generic-password -s credential-outlook-imap-refresh-token   -a bmo -w "<REFRESH_TOKEN>"
```

### 5. Install Python dependencies

```bash
pip3 install msal requests
```

## Configuration

```yaml
extensions:
  email:
    enabled: true
    provider: outlook
    outlook:
      client_id_credential:      credential-outlook-imap-client-id
      refresh_token_credential:  credential-outlook-imap-refresh-token
      mailbox:                   you@yourdomain.com
      imap_host:                 outlook.office365.com
      imap_port:                 993
      python_adapter:            extensions/email/outlook-imap.py
      max_results:               25
```

## Key Reference Code

### OutlookImapProvider (TypeScript wrapper)

```typescript
// providers/outlook-imap-provider.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class OutlookImapProvider implements EmailProvider {
  constructor(private readonly cfg: OutlookConfig) {}

  private async runAdapter(args: string[]): Promise<unknown> {
    const clientId      = await this.readCredential(this.cfg.client_id_credential);
    const refreshToken  = await this.readCredential(this.cfg.refresh_token_credential);

    const env = {
      ...process.env,
      OUTLOOK_CLIENT_ID:     clientId,
      OUTLOOK_REFRESH_TOKEN: refreshToken,
      OUTLOOK_MAILBOX:       this.cfg.mailbox,
      OUTLOOK_IMAP_HOST:     this.cfg.imap_host,
    };

    const { stdout } = await execFileAsync(
      'python3',
      [this.cfg.python_adapter, ...args],
      { env },
    );
    return JSON.parse(stdout);
  }

  private async readCredential(name: string): Promise<string> {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', name, '-w',
    ]);
    return stdout.trim();
  }

  async listInbox(options?: { maxResults?: number; unreadOnly?: boolean }): Promise<Email[]> {
    const args = ['list', '--folder', 'INBOX', '--max', String(options?.maxResults ?? 25)];
    if (options?.unreadOnly) args.push('--unread');
    return (await this.runAdapter(args)) as Email[];
  }

  async readEmail(id: string): Promise<Email> {
    return (await this.runAdapter(['read', '--uid', id])) as Email;
  }

  async searchEmails(query: string): Promise<Email[]> {
    // NOTE: default search checks SUBJECT and FROM only.
    // For body search pass --body flag.
    return (await this.runAdapter(['search', '--query', query])) as Email[];
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    await this.runAdapter(['move', '--uid', id, '--to', folder]);
  }

  // Sending is NOT supported — use the Graph provider for outbound mail.
  async sendEmail(): Promise<never> {
    throw new Error('OutlookImapProvider is receive-only. Use GraphEmailProvider to send.');
  }
}
```

### Python IMAP adapter with SASL XOAUTH2

```python
#!/usr/bin/env python3
# extensions/email/outlook-imap.py
import imaplib, base64, json, os, sys, argparse
import msal

CLIENT_ID    = os.environ['OUTLOOK_CLIENT_ID']
REFRESH_TOKEN = os.environ['OUTLOOK_REFRESH_TOKEN']
MAILBOX      = os.environ['OUTLOOK_MAILBOX']
IMAP_HOST    = os.environ.get('OUTLOOK_IMAP_HOST', 'outlook.office365.com')
AUTHORITY    = 'https://login.microsoftonline.com/common'
SCOPES       = ['https://outlook.office.com/IMAP.AccessAsUser.All']


def get_access_token() -> str:
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)
    result = app.acquire_token_by_refresh_token(REFRESH_TOKEN, scopes=SCOPES)
    if 'error' in result:
        raise RuntimeError(f"Token refresh failed: {result['error_description']}")
    return result['access_token']


def xoauth2_string(user: str, token: str) -> str:
    return base64.b64encode(
        f'user={user}\x01auth=Bearer {token}\x01\x01'.encode()
    ).decode()


def connect() -> imaplib.IMAP4_SSL:
    token  = get_access_token()
    xoauth = xoauth2_string(MAILBOX, token)
    imap   = imaplib.IMAP4_SSL(IMAP_HOST)
    imap.authenticate('XOAUTH2', lambda _: xoauth)
    return imap


def cmd_list(args) -> None:
    imap = connect()
    imap.select(args.folder)
    criteria = '(UNSEEN)' if args.unread else 'ALL'
    _, data = imap.search(None, criteria)
    uids = data[0].split()[-args.max:]
    emails = []
    for uid in reversed(uids):
        _, msg_data = imap.fetch(uid, '(ENVELOPE)')
        # parse envelope and emit minimal Email object
        emails.append({'id': uid.decode(), 'raw': msg_data[0][1].decode(errors='replace')})
    print(json.dumps(emails))
    imap.logout()


def cmd_search(args) -> None:
    imap = connect()
    imap.select('INBOX')
    # Search subject and sender; use BODY for full-text (slower)
    _, data = imap.search(None, f'(OR SUBJECT "{args.query}" FROM "{args.query}")')
    uids = data[0].split()
    results = []
    for uid in uids[-20:]:
        _, msg_data = imap.fetch(uid, '(RFC822)')
        results.append({'id': uid.decode(), 'raw': msg_data[0][1].decode(errors='replace')})
    print(json.dumps(results))
    imap.logout()


def cmd_move(args) -> None:
    imap = connect()
    imap.select('INBOX')
    imap.uid('COPY', args.uid, args.to)
    imap.uid('STORE', args.uid, '+FLAGS', r'(\Deleted)')
    imap.expunge()
    imap.logout()
    print(json.dumps({'ok': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command')

    p_list = sub.add_parser('list')
    p_list.add_argument('--folder', default='INBOX')
    p_list.add_argument('--max', type=int, default=25)
    p_list.add_argument('--unread', action='store_true')
    p_list.set_defaults(func=cmd_list)

    p_search = sub.add_parser('search')
    p_search.add_argument('--query', required=True)
    p_search.set_defaults(func=cmd_search)

    p_move = sub.add_parser('move')
    p_move.add_argument('--uid', required=True)
    p_move.add_argument('--to', required=True)
    p_move.set_defaults(func=cmd_move)

    args = parser.parse_args()
    if hasattr(args, 'func'):
        args.func(args)
    else:
        parser.print_help()
        sys.exit(1)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `AUTHENTICATE failed` | Wrong client ID — most common mistake | Verify you are using the **delegated** app's client ID, not the Graph app's ID |
| `error: invalid_grant` on token refresh | Refresh token expired (90-day inactivity limit) | Re-run device code flow to obtain a fresh refresh token; store it in Keychain |
| `IMAP.AccessAsUser.All` missing from consent | Permission not added or public client not enabled | Add permission in Azure portal; enable **Allow public client flows** |
| Body search returns no results | Default search only checks SUBJECT and FROM | Pass `--body` flag to the adapter or add `BODY "term"` to IMAP search criteria |
| Python adapter not found | Wrong path in config | Use absolute path or path relative to daemon working directory |
| Archive folder not searched | IMAP only searches selected folder | Call list/search again with `--folder Archive` |
