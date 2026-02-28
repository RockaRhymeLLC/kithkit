---
name: email-access
description: Read, search, and manage email across all mailboxes (Graph API and Himalaya). Use when checking email, reading messages, searching inbox, or managing mail.
argument-hint: [check | read <mailbox> | search <mailbox> "<query>"]
---

# Email Access

Quick-reference SOP for reading email across all mailboxes. Use this skill whenever you need to check, read, search, or manage email.

## Mailboxes

| Mailbox | Method | Account/Flag | Use For |
|---------|--------|-------------|---------|
| `bmo@bmobot.ai` | Graph API | Azure creds in Keychain | BMO's own mail — A2A verification codes, service notifications |
| `bmo_hurley@fastmail.com` | Himalaya | `-a fastmail` | BMO's Fastmail — needs himalaya account setup (see Setup section) |
| `daveh@outlook.com` | Himalaya | `-a outlook` | Dave's primary — EVERYTHING goes here unless he says otherwise |
| `daveh81@gmail.com` | Himalaya | `-a gmail` | Dave's secondary — Gmail |

**CRITICAL**: Dave's preferred email is `daveh@outlook.com` for all purposes. Never ask which email to use.

## Fastmail Access (bmo_hurley@fastmail.com)

Fastmail uses **JMAP** (not IMAP) with Bearer token auth. The token is in Keychain as `credential-fastmail-token`.

Himalaya config exists (`-a fastmail`) but will only work once the token has IMAP scope or himalaya is upgraded with JMAP support. Until then, use JMAP directly:

### Read Fastmail Inbox via JMAP

```bash
TOKEN=$(security find-generic-password -s credential-fastmail-token -w)

# Get account ID
ACCT=$(curl -s -L -H "Authorization: Bearer $TOKEN" \
  "https://api.fastmail.com/.well-known/jmap" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d['accounts'].keys())[0])")

# List recent emails
curl -s -X POST "https://api.fastmail.com/jmap/api/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$ACCT\",\"sort\":[{\"property\":\"receivedAt\",\"isAscending\":false}],\"limit\":10},\"0\"],[\"Email/get\",{\"accountId\":\"$ACCT\",\"#ids\":{\"resultOf\":\"0\",\"name\":\"Email/query\",\"path\":\"/ids\"},\"properties\":[\"id\",\"subject\",\"from\",\"receivedAt\",\"preview\"]},\"1\"]]}" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
emails = d['methodResponses'][1][1]['list']
for e in emails:
    fr = e.get('from',[{}])[0].get('email','?')
    print(f'{e[\"receivedAt\"][:16]} | {fr} | {e.get(\"subject\",\"(no subject)\")}')
"
```

### To enable himalaya for Fastmail
Either:
1. Upgrade himalaya to v1.2+ with JMAP support: `brew install himalaya`
2. Or generate a new Fastmail app password with IMAP scope at: Settings > Privacy & Security > App Passwords

## Quick Commands

### Check Inbox (Himalaya)

```bash
# Dave's Outlook (most common)
himalaya envelope list -a outlook --folder INBOX --max-count 10

# Dave's Gmail
himalaya envelope list -a gmail --folder INBOX --max-count 10

# BMO's Fastmail
himalaya envelope list -a fastmail --folder INBOX --max-count 10
```

### Read a Message (Himalaya)

```bash
himalaya message read -a outlook <message-id>
himalaya message read -a gmail <message-id>
himalaya message read -a fastmail <message-id>
```

### Search (Himalaya)

```bash
# Searches SUBJECT and FROM only (not body)
himalaya envelope list -a outlook --query "<search-term>"

# For body search, use the IMAP script (see reference.md)
```

**Himalaya search tip**: Only checks subject and from fields. For body search, you need raw IMAP — see reference.md.

### Check BMO's Email (Graph API)

Graph API requires a fresh OAuth token each time. Use this pattern:

```bash
# Step 1: Get credentials from Keychain
TENANT=$(security find-generic-password -s credential-azure-tenant-id -w)
CLIENT=$(security find-generic-password -s credential-azure-client-id -w)
SECRET=$(security find-generic-password -s credential-azure-secret-value -w)

# Step 2: Get token
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d "client_id=$CLIENT&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=$SECRET&grant_type=client_credentials" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# Step 3: Read inbox
curl -s "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/messages?\$top=5&\$orderby=receivedDateTime%20desc" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### Read Specific Message (Graph API)

```bash
curl -s "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/messages/<message-id>" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
m = json.load(sys.stdin)
print(f'From: {m[\"from\"][\"emailAddress\"][\"address\"]}')
print(f'Subject: {m[\"subject\"]}')
print(f'Date: {m[\"receivedDateTime\"]}')
print(f'Body: {m[\"body\"][\"content\"][:500]}')
"
```

### Search BMO's Email (Graph API)

```bash
# Search by keyword (subject, body, from)
curl -s "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/messages?\$search=%22verification%20code%22&\$top=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### Unread Only (Graph API)

```bash
curl -s "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/messages?\$filter=isRead%20eq%20false&\$top=10&\$orderby=receivedDateTime%20desc" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

## Common Tasks

### "Check my email" (Dave)
1. Check `himalaya envelope list -a outlook --folder INBOX --max-count 10`
2. Summarize: sender, subject, date for each
3. Only check gmail if Dave asks or outlook is empty

### "Check BMO's email"
1. Get Graph API token (Step 1-2 above)
2. Read inbox with `$top=5`
3. Summarize results

### "Find that email about X"
1. Try himalaya search first: `himalaya envelope list -a outlook --query "X"`
2. If not found, check Archive: `himalaya envelope list -a outlook --folder Archive --query "X"`
3. Dave archives emails — **always check Archive folder**
4. For body search, use raw IMAP (see reference.md)

### "Read verification code from BMO's email"
1. Get Graph API token
2. Search: `$search=%22verification%20code%22` or `$filter=from/emailAddress/address eq 'sender@domain.com'`
3. Read the most recent match
4. Extract the code from the body

## Important Notes

- Graph API tokens live ~1 hour. Generate fresh each time, never store to disk.
- Himalaya may emit WARN lines before JSON output — pipe through `python3` to parse safely.
- Dave's Outlook archive is a common hiding place — always check it when searching.
- The `yahoo-lindee` himalaya account exists but is Diane's email — only access when Dave specifically asks.

## References

- For Graph API setup, TypeScript provider code, and troubleshooting: see [integration/recipes/graph-email.md](../integration/recipes/graph-email.md)
- For Himalaya setup, multi-account config, and troubleshooting: see [integration/recipes/himalaya-email.md](../integration/recipes/himalaya-email.md)
- For composing and sending email: use the `/email-compose` skill
