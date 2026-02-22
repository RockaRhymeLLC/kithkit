# Dave's Gmail Account

| Field | Value |
|-------|-------|
| Owner | Dave |
| Address | daveh81@gmail.com |
| Script | `node scripts/email/himalaya.js` |
| Protocol | Himalaya CLI (IMAP) |
| Auth | Google app-specific password |

## Commands

```bash
node scripts/email/himalaya.js inbox
node scripts/email/himalaya.js unread
node scripts/email/himalaya.js read <id>
node scripts/email/himalaya.js mark-all-read
node scripts/email/himalaya.js search "query"
node scripts/email/himalaya.js send "to" "subject" "body" [--cc addr] [--bcc addr]
```

## Credentials

- **App password**: `credential-gmail-dave-app-password` in Keychain
- **Config**: `~/.config/himalaya/config.toml` (Himalaya CLI config)
- **Binary**: `/opt/homebrew/bin/himalaya` (v1.1.0, built with +oauth2)

## Notes

- Gmail IDs are numeric IMAP UIDs (e.g., `50441`)
- Himalaya CLI wraps IMAP — no direct API access
- App-specific passwords don't expire unless revoked in Google account
