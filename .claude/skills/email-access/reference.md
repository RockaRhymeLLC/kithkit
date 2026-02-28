# Email Access Reference

Advanced patterns and edge cases for email access.

## Raw IMAP Body Search (Outlook)

Himalaya search only checks SUBJECT and FROM. For body content search, use the IMAP script:

```bash
python3 scripts/email/outlook-imap.py search "search term"
```

If the script doesn't exist or fails, use himalaya to list recent envelopes and read each one to search the body manually:

```bash
# List recent envelopes
himalaya envelope list -a outlook --folder INBOX --max-count 50 --output json | \
  python3 -c "import json,sys; [print(f'{e[\"id\"]}: {e[\"subject\"]}') for e in json.load(sys.stdin)]"

# Read specific message body
himalaya message read -a outlook <id>
```

For IMAP BODY search via raw IMAP (if direct IMAP access is needed):

```python
import imaplib
imap = imaplib.IMAP4_SSL('outlook.office365.com')
imap.login('daveh@outlook.com', '<app-password>')
imap.select('INBOX')
_, nums = imap.search(None, 'BODY "search term"')
```

## Graph API Advanced Queries

### Filter by sender

```
$filter=from/emailAddress/address eq 'sender@example.com'
```

### Filter by date range

```
$filter=receivedDateTime ge 2026-02-27T00:00:00Z and receivedDateTime lt 2026-02-28T00:00:00Z
```

### Filter + sort

```
$filter=isRead eq false&$orderby=receivedDateTime desc&$top=10
```

### Select specific fields (reduce payload)

```
$select=id,subject,from,receivedDateTime,isRead&$top=20
```

### Mark as read

```bash
curl -s -X PATCH "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/messages/<id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isRead": true}'
```

### List folders

```bash
curl -s "https://graph.microsoft.com/v1.0/users/bmo@bmobot.ai/mailFolders" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

## Himalaya Folder Names

Common folder names by provider:

| Provider | Inbox | Sent | Archive | Trash |
|----------|-------|------|---------|-------|
| Outlook | INBOX | Sent | Archive | Deleted |
| Gmail | INBOX | [Gmail]/Sent Mail | [Gmail]/All Mail | [Gmail]/Trash |

List folders for any account:

```bash
himalaya folder list -a outlook
himalaya folder list -a gmail
```

## Himalaya JSON Output

For programmatic use, add `--output json`:

```bash
himalaya envelope list -a outlook --folder INBOX --max-count 5 --output json | python3 -c "
import json, sys
for e in json.load(sys.stdin):
    print(f'{e[\"id\"]:>6} | {e.get(\"date\",\"?\")[:16]} | {e.get(\"from\",{}).get(\"addr\",\"?\")} | {e.get(\"subject\",\"(no subject)\")}')
"
```

## Error Recovery

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `himalaya: command not found` | Not in PATH | Use `/opt/homebrew/bin/himalaya` |
| Graph API 401 | Token expired | Re-fetch token (tokens last ~1 hour) |
| Graph API 403 | Missing admin consent | Check Azure portal API permissions |
| Himalaya auth failure | Password/app password expired | Regenerate in provider settings |
| Empty search results | Checked wrong folder | Try Archive folder for Outlook |
| `$search` returns nothing | Graph indexing delay | Wait 30s after new mail, or use `$filter` for exact matches |
