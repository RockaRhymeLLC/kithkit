# Fastmail Integration

How to set up and use Fastmail for email integration.

## Prerequisites

- Fastmail account
- App-specific password (recommended over main password)
- Credentials stored in Keychain

## Setup

### 1. Create App Password

1. Log into Fastmail web interface
2. Go to Settings → Privacy & Security → Integrations
3. Create new app password for "Assistant"
4. Save the generated password

### 2. Store Credentials in Keychain

```bash
# Store email address
security add-generic-password -a "assistant" -s "credential-fastmail-email" -w "your@fastmail.com" -U

# Store app password
security add-generic-password -a "assistant" -s "credential-fastmail-password" -w "YOUR_APP_PASSWORD" -U
```

### 3. Add to Safe Senders (Optional)

If you want the assistant's email to be a safe sender:
```json
{
  "email": {
    "addresses": ["assistant@yourdomain.com"]
  }
}
```

## Connection Details

### IMAP (Receiving)

- Server: `imap.fastmail.com`
- Port: `993`
- Security: SSL/TLS

### SMTP (Sending)

- Server: `smtp.fastmail.com`
- Port: `465` (SSL) or `587` (STARTTLS)
- Security: SSL/TLS or STARTTLS

## Library Options

### nodemailer (Sending)

```bash
npm install nodemailer
```

```typescript
import nodemailer from 'nodemailer';
import { execSync } from 'child_process';

const email = execSync('security find-generic-password -s "credential-fastmail-email" -w').toString().trim();
const password = execSync('security find-generic-password -s "credential-fastmail-password" -w').toString().trim();

const transporter = nodemailer.createTransport({
  host: 'smtp.fastmail.com',
  port: 465,
  secure: true,
  auth: { user: email, pass: password }
});

await transporter.sendMail({
  from: email,
  to: 'recipient@example.com',
  subject: 'Subject',
  text: 'Plain text body',
  html: '<p>HTML body</p>'
});
```

### imapflow (Receiving)

```bash
npm install imapflow
```

```typescript
import { ImapFlow } from 'imapflow';

const client = new ImapFlow({
  host: 'imap.fastmail.com',
  port: 993,
  secure: true,
  auth: { user: email, pass: password }
});

await client.connect();

// Select inbox
let mailbox = await client.mailboxOpen('INBOX');

// Fetch recent messages
for await (let message of client.fetch('1:10', { envelope: true })) {
  console.log(message.envelope.subject);
}

await client.logout();
```

## Common Operations

### Send Email

```typescript
await transporter.sendMail({
  from: email,
  to: 'recipient@example.com',
  subject: 'Task Complete',
  text: 'Your research is complete. See attached.',
  attachments: [{ path: '/path/to/file.pdf' }]
});
```

### Check for New Messages

```typescript
// Fetch unseen messages
for await (let message of client.fetch({ seen: false }, { envelope: true, source: true })) {
  const from = message.envelope.from[0].address;
  const subject = message.envelope.subject;
  // Process message
}
```

### Search Messages

```typescript
// Search by sender
const results = await client.search({ from: 'important@example.com' });

// Search by subject
const results = await client.search({ subject: 'Invoice' });
```

## Security Notes

- Use app-specific password, not main account password
- Credentials stored encrypted in Keychain
- Apply safe sender rules before acting on email content
- Never share secure vault data with unknown senders

## Troubleshooting

**Authentication failed:**
- Verify app password is correct
- Check email address spelling
- Ensure app password hasn't been revoked

**Connection timeout:**
- Check internet connectivity
- Verify firewall allows ports 993/465/587
- Confirm Fastmail service status
