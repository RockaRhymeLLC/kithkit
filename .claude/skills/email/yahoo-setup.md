# Adding a Yahoo Email Account

Step-by-step instructions for adding Yahoo Mail accounts to BMO's email monitoring via Himalaya CLI (IMAP).

## Prerequisites

- Himalaya CLI installed (`/opt/homebrew/bin/himalaya`)
- macOS Keychain access for credential storage
- The Yahoo account owner's cooperation (for app password generation)

## Step 1: Generate a Yahoo App Password

Yahoo requires an app-specific password for third-party IMAP access. The account owner must do this:

1. Sign in to the Yahoo account at https://login.yahoo.com
2. Go to **Account Info** → **Account Security** (https://login.yahoo.com/account/security)
3. If **Two-step verification** is not enabled, enable it first (required for app passwords)
4. Click **Generate app password** (or "Generate and manage app passwords")
5. Select **Other App**, name it something like "BMO" or "Himalaya"
6. Copy the generated 16-character password (spaces are optional — Yahoo accepts with or without)

**Important**: The app password is shown only once. If lost, revoke and generate a new one.

## Step 2: Store Credentials in Keychain

```bash
# Naming convention: credential-yahoo-{owner}-app-password
security add-generic-password -a "assistant" -s "credential-yahoo-{owner}-app-password" -w "{app-password}" -U
```

Example for Lindee's account:
```bash
security add-generic-password -a "assistant" -s "credential-yahoo-lindee-app-password" -w "xxxx xxxx xxxx xxxx" -U
```

## Step 3: Add Himalaya Account Config

Edit `~/.config/himalaya/config.toml` and add a new account section:

```toml
[accounts.yahoo-{owner}]
email = "{email}@yahoo.com"
display-name = "{Display Name}"

folder.aliases.inbox = "Inbox"
folder.aliases.sent = "Sent"
folder.aliases.drafts = "Draft"
folder.aliases.trash = "Trash"
folder.aliases.junk = "Bulk"

backend.type = "imap"
backend.host = "imap.mail.yahoo.com"
backend.port = 993
backend.login = "{email}@yahoo.com"
backend.auth.type = "password"
backend.auth.cmd = "security find-generic-password -s credential-yahoo-{owner}-app-password -w"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.mail.yahoo.com"
message.send.backend.port = 465
message.send.backend.login = "{email}@yahoo.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "security find-generic-password -s credential-yahoo-{owner}-app-password -w"
```

### Yahoo IMAP/SMTP Server Details

| Protocol | Host | Port | Encryption |
|----------|------|------|------------|
| IMAP | imap.mail.yahoo.com | 993 | SSL/TLS |
| SMTP | smtp.mail.yahoo.com | 465 | SSL/TLS |

## Step 4: Test the Connection

```bash
# Verify account appears
himalaya account list

# Test inbox access
himalaya envelope list -a yahoo-{owner} --page-size 5
```

## Step 5: Add to Daemon Config

In `cc4me.config.yaml`, add a new himalaya provider entry under `channels.email.providers`:

```yaml
channels:
  email:
    providers:
      # ... existing providers ...
      - type: "himalaya"
        account: "yahoo-{owner}"
```

## Step 6: Create Account Reference Doc

Create `.claude/skills/email/{owner}-yahoo.md` with account-specific details (use `dave-gmail.md` as a template):

```markdown
# {Owner}'s Yahoo Account

| Field | Value |
|-------|-------|
| Owner | {Name} |
| Address | {email}@yahoo.com |
| Protocol | Himalaya CLI (IMAP) |
| Auth | Yahoo app-specific password |

## Credentials

- **App password**: `credential-yahoo-{owner}-app-password` in Keychain
- **Config**: `~/.config/himalaya/config.toml` (account: `yahoo-{owner}`)

## Notes

- Yahoo app passwords don't expire unless revoked
- Yahoo folder names: Inbox, Sent, Draft, Trash, Bulk (junk)
- If auth fails, the app password may have been revoked — generate a new one
```

## Step 7: Restart Daemon

```bash
launchctl unload ~/Library/LaunchAgents/com.bmo.daemon.plist
launchctl load ~/Library/LaunchAgents/com.bmo.daemon.plist
```

The new account will be picked up by the email-check task on its next 15-minute cycle.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Auth failed | Verify app password is correct. Regenerate if needed |
| "Web login required" | Account may have security hold — owner needs to log in via browser and confirm activity |
| 2FA not available | Yahoo requires a verified phone number to enable 2FA, which is required for app passwords |
| Folder not found | Yahoo folder names differ from Gmail/Outlook — check exact names with `himalaya folder list -a yahoo-{owner}` |
| Rate limited | Yahoo IMAP has aggressive rate limits — avoid rapid repeated connections. The 15-minute check interval is fine |
