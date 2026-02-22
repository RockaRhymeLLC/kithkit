# Recipe: Outlook IMAP + OAuth2 Integration

Connect your Kithkit agent to an Outlook/Hotmail mailbox using IMAP with modern OAuth2 authentication. Microsoft deprecated Basic Auth for Outlook in 2022, so OAuth2 is now required.

**Important**: This recipe uses a **separate Azure AD app registration** from the Microsoft Graph email recipe (`graph-email.md`). The two integrations require different OAuth scopes and cannot share a client ID. If you already have a Graph email app, you still need to create a new app for IMAP.

This integration is **receive-only** for most use cases. For sending, use the Graph email provider — Outlook IMAP SMTP with OAuth2 is significantly more complex and rarely necessary when Graph is available.

---

## Prerequisites

- An Outlook.com, Hotmail.com, or Microsoft 365 personal/business account
- Access to the Azure portal (`portal.azure.com`) to register a second Azure AD app
- Python 3.9+ (the IMAP adapter is a Python script)
- The `requests` and `msal` Python libraries
- Node.js 18+ (daemon runtime)
- The Kithkit daemon configured and running

---

## Setup Steps

### Step 1 — Register a NEW Azure AD application (IMAP-specific)

Do not reuse any existing app registration. IMAP requires different permissions from the Graph API, and Microsoft validates that the app has the correct scopes.

1. Sign in to [portal.azure.com](https://portal.azure.com)
2. Navigate to **Azure Active Directory** → **App registrations** → **New registration**
3. Name: `Kithkit Outlook IMAP` (use a distinct name so you don't confuse it with your Graph app)
4. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (this covers Outlook.com and Hotmail)
5. Redirect URI: set type to **Public client/native** and value `https://login.microsoftonline.com/common/oauth2/nativeclient`
6. Click **Register**

Note the **Application (client) ID** — this is your IMAP client ID. Store it separately from any Graph client ID.

### Step 2 — Add IMAP permissions

1. Go to **API permissions** → **Add a permission**
2. Choose **Microsoft Graph** → **Delegated permissions** (NOT Application — IMAP requires delegated)
3. Search for and add:
   - `IMAP.AccessAsUser.All` — IMAP access as the signed-in user
   - `offline_access` — allows token refresh without re-login
   - `User.Read` — required for MSAL to validate the user
4. Click **Add permissions**

You do NOT need admin consent for delegated permissions — the user grants them during the device code flow.

### Step 3 — Store the client ID in Keychain

```bash
# Note: use a DIFFERENT keychain service name from the Graph provider
security add-generic-password \
  -s credential-outlook-client-id \
  -a kithkit \
  -w "YOUR_IMAP_CLIENT_ID_HERE"
```

Verify:

```bash
security find-generic-password -s credential-outlook-client-id -w
```

The Graph recipe uses `credential-azure-client-id`. This recipe uses `credential-outlook-client-id`. They must not be the same value — they are different Azure apps.

### Step 4 — Install Python dependencies

```bash
pip3 install requests msal
```

Or in a virtual environment (recommended):

```bash
python3 -m venv ~/.kithkit/outlook-venv
source ~/.kithkit/outlook-venv/bin/activate
pip install requests msal
```

### Step 5 — Run the device code flow to authenticate

The first time you use this integration, the user must complete a one-time interactive authentication. Run the Python script in `auth` mode:

```bash
python3 scripts/email/outlook-imap.py --auth
```

The script will print a URL and a code:

```
To sign in, use a web browser to open https://microsoft.com/devicelogin
and enter the code: ABCD1234
Waiting for authentication...
```

1. Open the URL in a browser
2. Enter the code
3. Sign in with the Outlook account
4. Accept the permissions prompt

After successful auth, the script saves a token cache file (the path is configurable — see Reference Code). Future calls will use the cached refresh token automatically. Re-run `--auth` only if the token cache is deleted or the refresh token expires (typically after 90 days of inactivity).

---

## Config Snippet

```yaml
channels:
  email:
    enabled: true
    providers:
      - type: "outlook"
        user_email: "you@outlook.com"
        # Keychain key for the IMAP client ID
        keychain:
          client_id: "credential-outlook-client-id"
        # Path to the token cache file (relative to project root or absolute)
        token_cache_path: ".claude/state/outlook-token-cache.json"
        # Path to the Python adapter script
        script_path: "scripts/email/outlook-imap.py"
        # Python interpreter (use venv path if applicable)
        python: "python3"

    # For sending, configure the Graph provider alongside Outlook IMAP:
      - type: "graph"
        user_email: "you@yourdomain.com"
```

---

## Reference Code

### EmailProvider interface

All Kithkit email providers implement this shared interface. The Outlook IMAP provider delegates to a Python script for IMAP operations. Providers are registered in `channels.email.providers` and selected by the daemon at runtime.

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

### Outlook IMAP TypeScript provider (daemon side)

The TypeScript provider is a thin wrapper that shells out to the Python script and parses its JSON output. All IMAP protocol logic lives in Python.

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { EmailProvider, EmailMessage, SendOptions } from "./types.js";

const execFileAsync = promisify(execFile);

export class OutlookImapProvider implements EmailProvider {
  name = "outlook";

  constructor(
    private userEmail: string,
    private scriptPath: string = "scripts/email/outlook-imap.py",
    private python: string = "python3",
    private keychainClientId: string = "credential-outlook-client-id"
  ) {}

  isConfigured(): boolean {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("security", [
        "find-generic-password", "-s", this.keychainClientId,
      ], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  private async run(command: string, args: Record<string, any> = {}): Promise<any> {
    const jsonArgs = JSON.stringify({ command, ...args });

    const { stdout, stderr } = await execFileAsync(
      this.python,
      [this.scriptPath, "--json", jsonArgs],
      { timeout: 30_000 }
    );

    if (stderr) {
      // Log but don't throw — Python libraries write non-fatal warnings to stderr
      console.warn("[outlook-imap] stderr:", stderr.trim());
    }

    if (!stdout.trim()) return null;

    const result = JSON.parse(stdout.trim());

    if (result.error) {
      throw new Error(`Outlook IMAP error: ${result.error}`);
    }

    return result.data ?? result;
  }

  async listInbox(limit = 25, unreadOnly = false): Promise<EmailMessage[]> {
    const data = await this.run("list_inbox", { limit, unread_only: unreadOnly });
    return (data ?? []).map(mapMessage);
  }

  async readEmail(id: string): Promise<EmailMessage | null> {
    const data = await this.run("read_email", { id });
    return data ? mapMessage(data) : null;
  }

  async markAsRead(id: string): Promise<void> {
    await this.run("mark_read", { id });
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    await this.run("move_email", { id, folder });
  }

  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    const data = await this.run("search", { query, limit });
    return (data ?? []).map(mapMessage);
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {}
  ): Promise<void> {
    // Sending via IMAP SMTP + OAuth2 is complex — delegate to Graph provider
    throw new Error(
      "Outlook IMAP provider is receive-only. Configure the Graph email provider for sending."
    );
  }
}

function mapMessage(raw: any): EmailMessage {
  return {
    id: String(raw.id ?? raw.uid ?? ""),
    subject: raw.subject ?? "(no subject)",
    from: raw.from ?? "",
    to: Array.isArray(raw.to) ? raw.to : [raw.to ?? ""],
    date: raw.date ?? "",
    body: raw.body ?? "",
    bodyHtml: raw.body_html,
    isRead: raw.is_read ?? false,
    folder: raw.folder ?? "INBOX",
  };
}
```

### Python IMAP adapter (`scripts/email/outlook-imap.py`)

```python
#!/usr/bin/env python3
"""
Outlook IMAP + OAuth2 adapter for Kithkit.

Usage:
  python3 outlook-imap.py --auth              # Interactive device code flow
  python3 outlook-imap.py --json '{"command": "list_inbox", "limit": 10}'
  python3 outlook-imap.py --json '{"command": "read_email", "id": "123"}'
  python3 outlook-imap.py --json '{"command": "mark_read", "id": "123"}'
  python3 outlook-imap.py --json '{"command": "move_email", "id": "123", "folder": "Archive"}'
  python3 outlook-imap.py --json '{"command": "search", "query": "invoice", "limit": 5}'
"""

import argparse
import imaplib
import json
import os
import subprocess
import sys
from email import policy
from email.parser import BytesParser
from pathlib import Path

import msal

# ── Configuration ──────────────────────────────────────────────────────────────

IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993
SCOPE = ["https://outlook.office365.com/IMAP.AccessAsUser.All", "offline_access", "User.Read"]
AUTHORITY = "https://login.microsoftonline.com/common"

TOKEN_CACHE_PATH = Path(
    os.environ.get("OUTLOOK_TOKEN_CACHE", ".claude/state/outlook-token-cache.json")
)

# ── Auth helpers ───────────────────────────────────────────────────────────────

def get_client_id() -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", "credential-outlook-client-id", "-w"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()

def get_msal_app(client_id: str) -> msal.PublicClientApplication:
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE_PATH.exists():
        cache.deserialize(TOKEN_CACHE_PATH.read_text())

    app = msal.PublicClientApplication(
        client_id,
        authority=AUTHORITY,
        token_cache=cache,
    )
    return app, cache

def get_access_token(interactive: bool = False) -> str:
    client_id = get_client_id()
    app, cache = get_msal_app(client_id)

    accounts = app.get_accounts()
    result = None

    if accounts and not interactive:
        # Try to refresh silently first
        result = app.acquire_token_silent(SCOPE, account=accounts[0])

    if not result or "access_token" not in result:
        if not interactive:
            raise RuntimeError(
                "No cached token. Run with --auth to authenticate interactively."
            )
        # Device code flow
        flow = app.initiate_device_flow(scopes=SCOPE)
        if "message" not in flow:
            raise RuntimeError(f"Failed to initiate device flow: {flow}")

        print(flow["message"], flush=True)
        result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        raise RuntimeError(f"Auth failed: {result.get('error_description', result)}")

    # Persist updated cache
    TOKEN_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE_PATH.write_text(cache.serialize())

    return result["access_token"]

# ── IMAP connection ────────────────────────────────────────────────────────────

def connect_imap() -> imaplib.IMAP4_SSL:
    token = get_access_token()
    # Retrieve the user email from config or environment
    user_email = os.environ.get("OUTLOOK_USER_EMAIL", "")
    if not user_email:
        raise RuntimeError("OUTLOOK_USER_EMAIL environment variable not set")

    # OAuth2 SASL string format
    auth_string = f"user={user_email}\x01auth=Bearer {token}\x01\x01"

    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.authenticate("XOAUTH2", lambda x: auth_string.encode())
    return conn

# ── Commands ───────────────────────────────────────────────────────────────────

def list_inbox(limit: int = 25, unread_only: bool = False) -> list:
    conn = connect_imap()
    conn.select("INBOX")

    criterion = "UNSEEN" if unread_only else "ALL"
    _, data = conn.search(None, criterion)
    uids = data[0].split()[-limit:]  # most recent N

    messages = []
    for uid in reversed(uids):  # newest first
        _, msg_data = conn.fetch(uid, "(RFC822)")
        msg = BytesParser(policy=policy.default).parsebytes(msg_data[0][1])
        messages.append({
            "id": uid.decode(),
            "subject": str(msg["subject"] or "(no subject)"),
            "from": str(msg["from"] or ""),
            "to": [str(msg["to"] or "")],
            "date": str(msg["date"] or ""),
            "body": msg.get_body(preferencelist=("plain",)).get_content()
                    if msg.get_body(preferencelist=("plain",)) else "",
            "is_read": criterion != "UNSEEN",
            "folder": "INBOX",
        })

    conn.logout()
    return messages

def read_email(id: str) -> dict:
    conn = connect_imap()
    conn.select("INBOX")
    _, msg_data = conn.fetch(id, "(RFC822)")
    conn.logout()

    if not msg_data or not msg_data[0]:
        return None

    msg = BytesParser(policy=policy.default).parsebytes(msg_data[0][1])
    plain_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))

    return {
        "id": id,
        "subject": str(msg["subject"] or "(no subject)"),
        "from": str(msg["from"] or ""),
        "to": [str(msg["to"] or "")],
        "date": str(msg["date"] or ""),
        "body": plain_part.get_content() if plain_part else "",
        "body_html": html_part.get_content() if html_part else None,
        "is_read": True,
        "folder": "INBOX",
    }

def mark_read(id: str) -> None:
    conn = connect_imap()
    conn.select("INBOX")
    conn.store(id, "+FLAGS", "\\Seen")
    conn.logout()

def move_email(id: str, folder: str) -> None:
    conn = connect_imap()
    conn.select("INBOX")
    # IMAP COPY then DELETE
    conn.copy(id, folder)
    conn.store(id, "+FLAGS", "\\Deleted")
    conn.expunge()
    conn.logout()

def search_emails(query: str, limit: int = 10) -> list:
    conn = connect_imap()
    conn.select("INBOX")
    # IMAP SEARCH SUBJECT is basic; use BODY for full-text (slower)
    _, data = conn.search(None, f'SUBJECT "{query}"')
    uids = data[0].split()[-limit:]

    messages = []
    for uid in reversed(uids):
        _, msg_data = conn.fetch(uid, "(RFC822)")
        msg = BytesParser(policy=policy.default).parsebytes(msg_data[0][1])
        messages.append({
            "id": uid.decode(),
            "subject": str(msg["subject"] or "(no subject)"),
            "from": str(msg["from"] or ""),
            "to": [str(msg["to"] or "")],
            "date": str(msg["date"] or ""),
            "body": "",
            "is_read": False,
            "folder": "INBOX",
        })

    conn.logout()
    return messages

# ── Entry point ────────────────────────────────────────────────────────────────

def output(data) -> None:
    print(json.dumps({"data": data}))

def error(msg: str) -> None:
    print(json.dumps({"error": msg}))
    sys.exit(1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--auth", action="store_true", help="Run interactive auth flow")
    parser.add_argument("--json", type=str, help="JSON command payload")
    args = parser.parse_args()

    if args.auth:
        get_access_token(interactive=True)
        print("Authentication successful. Token cached.")
        return

    if not args.json:
        error("Provide --auth or --json")

    try:
        payload = json.loads(args.json)
        cmd = payload.get("command")

        if cmd == "list_inbox":
            output(list_inbox(payload.get("limit", 25), payload.get("unread_only", False)))
        elif cmd == "read_email":
            output(read_email(payload["id"]))
        elif cmd == "mark_read":
            mark_read(payload["id"])
            output(None)
        elif cmd == "move_email":
            move_email(payload["id"], payload["folder"])
            output(None)
        elif cmd == "search":
            output(search_emails(payload.get("query", ""), payload.get("limit", 10)))
        else:
            error(f"Unknown command: {cmd}")

    except Exception as e:
        error(str(e))

if __name__ == "__main__":
    main()
```

---

## Troubleshooting

**Using the wrong client ID (most common problem)**

This integration requires its own Azure AD app. Do not use the same client ID as your Graph email app. The Graph app is registered with Application permissions; this IMAP app needs Delegated permissions with the `IMAP.AccessAsUser.All` scope.

- Graph client ID is in Keychain as `credential-azure-client-id`
- IMAP client ID must be in Keychain as `credential-outlook-client-id` (a different entry)

If you used the wrong client ID and authenticated, delete the token cache and re-auth with the correct app:

```bash
rm .claude/state/outlook-token-cache.json
python3 scripts/email/outlook-imap.py --auth
```

**`AUTHENTICATE failed` on IMAP connect**

- The token was obtained with the wrong scopes (e.g., Graph scopes instead of IMAP scopes)
- Delete the token cache and re-run `--auth` with the correct IMAP app client ID
- Verify the Azure app has `IMAP.AccessAsUser.All` as a Delegated permission (not Application)
- Ensure IMAP is enabled on the account: for Microsoft 365 tenants, an admin may need to enable IMAP at the organizational level in the Exchange admin center

**Device code flow re-authentication needed**

Refresh tokens expire after 90 days of inactivity (Microsoft default). When the cached token can no longer be refreshed silently, the Python script raises `RuntimeError: No cached token`. Re-run:

```bash
python3 scripts/email/outlook-imap.py --auth
```

If the tenant has Conditional Access policies (MFA required periodically), re-auth may be more frequent.

**`credential-outlook-client-id` not found in Keychain**

```bash
security add-generic-password \
  -s credential-outlook-client-id \
  -a kithkit \
  -w "YOUR_IMAP_CLIENT_ID"
```

Verify: `security find-generic-password -s credential-outlook-client-id -w`

**`OUTLOOK_USER_EMAIL` environment variable not set**

The Python script reads the user email from `OUTLOOK_USER_EMAIL`. Set it in your daemon's environment, or modify the script to read from a config file:

```bash
# In your daemon's launchd plist or .env:
OUTLOOK_USER_EMAIL=you@outlook.com
```

**Sending fails with "receive-only" error**

The Outlook IMAP provider intentionally does not support sending. Configure the Microsoft Graph email provider (`graph-email.md`) alongside this provider for outbound email. They can coexist — IMAP for reading Outlook specifically, Graph for sending.

**Token cache file permission error**

The token cache contains sensitive OAuth2 credentials. Restrict permissions after first auth:

```bash
chmod 600 .claude/state/outlook-token-cache.json
```

Do not commit this file to version control — add it to `.gitignore`.
