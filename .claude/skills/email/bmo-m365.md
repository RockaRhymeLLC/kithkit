# Microsoft Graph Integration

Email and calendar access via Microsoft Graph API.

## Overview

| Field | Value |
|-------|-------|
| Email | Stored in Keychain (`credential-graph-user-email`) |
| Tenant | Your M365 tenant |
| App Name | Your registered Azure AD app |
| Auth Flow | OAuth2 Client Credentials (daemon, no user interaction) |
| Script | `scripts/email/graph.js` |

## Setup

### 1. Register Azure AD Application

1. Go to [Azure Portal](https://portal.azure.com) > Azure Active Directory > App registrations
2. Click "New registration"
3. Name your app (e.g., "CC4Me Mail Client")
4. Select "Accounts in this organizational directory only"
5. Click "Register"

### 2. Configure API Permissions

In your app registration, go to "API permissions" and add:

| Permission | Type | Scope |
|---|---|---|
| Mail.ReadWrite | Application | Read/write all mailbox messages |
| Mail.Send | Application | Send mail as any user |
| User.Read.All | Application | Read user profiles (optional) |

Click "Grant admin consent" after adding permissions.

### 3. Create Client Secret

1. Go to "Certificates & secrets"
2. Click "New client secret"
3. Set a description and expiry
4. Copy the secret value immediately (shown only once)

### 4. Store Credentials in Keychain

```bash
# Application (client) ID - from app registration overview
security add-generic-password -a "assistant" -s "credential-azure-client-id" -w "YOUR_CLIENT_ID" -U

# Directory (tenant) ID - from app registration overview
security add-generic-password -a "assistant" -s "credential-azure-tenant-id" -w "YOUR_TENANT_ID" -U

# Client secret value - from certificates & secrets
security add-generic-password -a "assistant" -s "credential-azure-secret-value" -w "YOUR_SECRET_VALUE" -U

# Client secret ID (reference only, not used for auth)
security add-generic-password -a "assistant" -s "credential-azure-secret-id" -w "YOUR_SECRET_ID" -U

# User email address (the mailbox to access)
security add-generic-password -a "assistant" -s "credential-graph-user-email" -w "user@yourdomain.com" -U
```

## Credentials (Keychain)

| Keychain Entry | Purpose |
|---|---|
| `credential-azure-client-id` | Application (client) ID |
| `credential-azure-tenant-id` | Directory (tenant) ID |
| `credential-azure-secret-value` | Client secret value (used for auth) |
| `credential-azure-secret-id` | Client secret ID (reference only) |
| `credential-graph-user-email` | User email address |

## Optional Permissions

If you need calendar, contacts, tasks, or files access, add these permissions:

| Permission | Scope |
|---|---|
| Calendars.ReadWrite | Read/write calendar events |
| Contacts.ReadWrite | Read/write contacts |
| MailboxSettings.ReadWrite | Read/write mailbox settings (OOO, timezone) |
| Tasks.ReadWrite.All | Read/write Microsoft To Do tasks |
| Files.ReadWrite.All | Read/write OneDrive files |

## Usage

```bash
# Get OAuth token (for manual testing)
curl -s -X POST "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${CLIENT_ID}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${SECRET}&grant_type=client_credentials"

# Use the helper script
node scripts/email/graph.js inbox
node scripts/email/graph.js send "to@example.com" "Subject" "Body"
```

## Important Notes

- Uses `/users/{email}/...` endpoints (not `/me/` which requires delegated auth)
- Token expires after 1 hour; script fetches a fresh token each call
- `sendMail` returns 202 Accepted with empty body (not 200 with JSON)
- Attachments use base64-encoded inline content (`#microsoft.graph.fileAttachment`)
- Client secrets expire; set a calendar reminder to rotate before expiry

## Troubleshooting

**Token request fails (401/403):**
- Verify client ID, tenant ID, and secret are correct
- Check that admin consent has been granted
- Ensure the secret hasn't expired

**Mail operations fail (403):**
- Confirm Mail.ReadWrite and Mail.Send permissions are granted
- Ensure admin consent was given (not just user consent)
- Verify the user email exists in your tenant

**sendMail returns empty response:**
- This is expected; 202 Accepted means success
- The script handles this correctly (no JSON parsing of empty body)
