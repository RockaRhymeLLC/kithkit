# Dave's Outlook Account

| Field | Value |
|-------|-------|
| Owner | Dave |
| Address | daveh@outlook.com |
| Script | `python3 scripts/email/outlook-imap.py` |
| Protocol | Python imaplib + smtplib (XOAUTH2) |
| Auth | OAuth2 device code flow |

## Commands

```bash
python3 scripts/email/outlook-imap.py inbox
python3 scripts/email/outlook-imap.py unread
python3 scripts/email/outlook-imap.py read <id>
python3 scripts/email/outlook-imap.py mark-read <id>
python3 scripts/email/outlook-imap.py mark-all-read
python3 scripts/email/outlook-imap.py search "query"
python3 scripts/email/outlook-imap.py send "to@email.com" "Subject" "Body text"
python3 scripts/email/outlook-imap.py reply <id> "Reply body text"
```

**Send**: Uses SMTP with XOAUTH2 via `smtp.office365.com:587`. Reply command auto-threads (In-Reply-To, References headers).

## Credentials

- **Service**: `himalaya-cli` in Keychain
- **Access token**: `outlook-imap-oauth2-access-token`
- **Refresh token**: `outlook-imap-oauth2-refresh-token`
- Access tokens expire after ~1 hour

## Token Refresh

**Auto-refresh**: The script automatically refreshes expired access tokens using the stored refresh token. No manual intervention needed unless the refresh token itself expires (rare — typically 90 days of inactivity).

If auto-refresh fails (refresh token expired), re-run the device code flow:

```python
# Step 1: Initiate device code flow
python3 -c "
import msal, json
app = msal.PublicClientApplication('c2705aeb-5583-4cae-8e04-b5ef36495bb3',
      authority='https://login.microsoftonline.com/consumers')
flow = app.initiate_device_flow(scopes=[
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send'])
print(flow['message'])
with open('/tmp/outlook-oauth-flow.json','w') as f: json.dump(flow, f)
"

# Step 2: Dave completes auth at the URL shown, then run:
python3 -c "
import msal, json, subprocess
app = msal.PublicClientApplication('c2705aeb-5583-4cae-8e04-b5ef36495bb3',
      authority='https://login.microsoftonline.com/consumers')
flow = json.load(open('/tmp/outlook-oauth-flow.json'))
result = app.acquire_token_by_device_flow(flow)
for name in ['access-token', 'refresh-token']:
    for prefix in ['outlook-imap-oauth2-', 'outlook-smtp-oauth2-']:
        key = prefix + name
        val = result['refresh_token' if 'refresh' in name else 'access_token']
        subprocess.run(['security','add-generic-password','-a',key,'-s','himalaya-cli','-w',val,'-U'], check=True)
print('Tokens refreshed!')
"
```

## Notes

- Outlook IDs are IMAP sequence numbers (e.g., `7196`) — can shift if messages are deleted
- Himalaya CLI hangs on Outlook IMAP OAuth2 — use `outlook-imap.py` instead
- Tokens stored under `himalaya-cli` service name for historical consistency
- Included in daemon auto-check via `OutlookProvider` (type: `"outlook"` in config)
