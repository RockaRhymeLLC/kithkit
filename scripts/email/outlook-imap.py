#!/usr/bin/env python3
"""
Outlook.com IMAP+SMTP client via OAuth2 (XOAUTH2).
Reads and sends Outlook email using OAuth2 tokens stored in Keychain.

Usage:
    outlook-imap.py inbox              - Show recent inbox messages
    outlook-imap.py unread             - Show unread messages only
    outlook-imap.py read <id>          - Read a specific email (auto-marks as read)
    outlook-imap.py mark-read <id>     - Mark an email as read
    outlook-imap.py mark-all-read      - Mark all unread inbox emails as read
    outlook-imap.py search "query"     - Search emails
    outlook-imap.py folders            - List available IMAP folders
    outlook-imap.py move <id> <folder> - Move a message to a folder
    outlook-imap.py create-folder <name> - Create a new IMAP folder
    outlook-imap.py send "to" "subject" "body" - Send an email
    outlook-imap.py reply <id> "body"  - Reply to a specific email
"""

import base64
import imaplib
import email
import email.header
import email.mime.text
import email.utils
import json
import os
import smtplib
import subprocess
import sys
from datetime import datetime

# Global flag for JSON output (set by --json argument)
JSON_OUTPUT = False

IMAP_HOST = 'outlook.office365.com'
IMAP_PORT = 993
SMTP_HOST = 'smtp.office365.com'
SMTP_PORT = 587
AUTHORITY = 'https://login.microsoftonline.com/consumers'
SCOPES = ['https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send']

def get_keychain(service, account=None):
    """Get a value from macOS Keychain."""
    try:
        cmd = ['security', 'find-generic-password', '-s', service]
        if account:
            cmd.extend(['-a', account])
        cmd.append('-w')
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def get_user():
    """Get the Outlook email address from Keychain or environment."""
    return os.environ.get('OUTLOOK_USER') or get_keychain('credential-outlook-user') or get_keychain('himalaya-cli', 'outlook-user')


def get_client_id():
    """Get the Azure AD client ID from Keychain or environment."""
    return os.environ.get('OUTLOOK_CLIENT_ID') or get_keychain('credential-outlook-client-id') or get_keychain('credential-azure-client-id')


# Initialize from Keychain/environment (set before first use)
USER = get_user()
CLIENT_ID = get_client_id()

if not USER:
    print('ERROR: Outlook user email not found. Set OUTLOOK_USER env var or store in Keychain.', file=sys.stderr)
    sys.exit(1)
if not CLIENT_ID:
    print('ERROR: Azure client ID not found. Set OUTLOOK_CLIENT_ID env var or store in Keychain.', file=sys.stderr)
    sys.exit(1)


def set_keychain(service, account, value):
    """Store a value in macOS Keychain (update if exists)."""
    subprocess.run(
        ['security', 'add-generic-password', '-s', service, '-a', account, '-w', value, '-U'],
        capture_output=True, check=True
    )

def get_access_token():
    """Get OAuth2 access token from Keychain."""
    token = get_keychain('himalaya-cli', 'outlook-imap-oauth2-access-token')
    if not token:
        print('ERROR: No OAuth2 access token found in Keychain.', file=sys.stderr)
        print('Run the device code flow to authorize.', file=sys.stderr)
        sys.exit(1)
    return token

def refresh_access_token():
    """Use refresh token to get a new access token via MSAL."""
    import msal
    refresh_token = get_keychain('himalaya-cli', 'outlook-imap-oauth2-refresh-token')
    if not refresh_token:
        print('ERROR: No refresh token in Keychain. Run device code flow.', file=sys.stderr)
        sys.exit(1)

    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)
    result = app.acquire_token_by_refresh_token(refresh_token, scopes=SCOPES)

    if 'access_token' not in result:
        error = result.get('error_description', result.get('error', 'unknown'))
        print(f'ERROR: Token refresh failed: {error}', file=sys.stderr)
        print('Run the device code flow to re-authorize.', file=sys.stderr)
        sys.exit(1)

    # Store new tokens in Keychain (both IMAP and SMTP prefixes for consistency)
    for prefix in ['outlook-imap-oauth2-', 'outlook-smtp-oauth2-']:
        set_keychain('himalaya-cli', f'{prefix}access-token', result['access_token'])
        if 'refresh_token' in result:
            set_keychain('himalaya-cli', f'{prefix}refresh-token', result['refresh_token'])

    print('Token auto-refreshed.', file=sys.stderr)
    return result['access_token']

def connect():
    """Connect to Outlook IMAP with XOAUTH2. Auto-refreshes expired tokens."""
    token = get_access_token()

    try:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        auth_string = f'user={USER}\x01auth=Bearer {token}\x01\x01'
        imap.authenticate('XOAUTH2', lambda x: auth_string.encode())
        return imap
    except imaplib.IMAP4.error:
        # Access token expired — try refresh
        token = refresh_access_token()
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
        auth_string = f'user={USER}\x01auth=Bearer {token}\x01\x01'
        imap.authenticate('XOAUTH2', lambda x: auth_string.encode())
        return imap

def decode_header(raw):
    """Decode an email header value."""
    if not raw:
        return ''
    parts = email.header.decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            try:
                decoded.append(part.decode(charset or 'utf-8', errors='replace'))
            except (LookupError, UnicodeDecodeError):
                decoded.append(part.decode('latin-1'))
        else:
            decoded.append(part)
    return ' '.join(decoded)

def parse_envelope(msg_data, msg_id):
    """Parse an email message into an envelope dict."""
    msg = email.message_from_bytes(msg_data)
    from_addr = decode_header(msg.get('From', ''))
    subject = decode_header(msg.get('Subject', '(no subject)'))
    date_str = msg.get('Date', '')

    return {
        'id': msg_id,
        'from': from_addr,
        'subject': subject,
        'date': date_str,
    }

def get_body(msg_data):
    """Extract plain text body from email."""
    msg = email.message_from_bytes(msg_data)

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == 'text/plain':
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or 'utf-8'
                return payload.decode(charset, errors='replace')
        # Fallback to HTML if no plain text
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == 'text/html':
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or 'utf-8'
                return payload.decode(charset, errors='replace')
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or 'utf-8'
            return payload.decode(charset, errors='replace')

    return '(no body)'

def cmd_inbox(limit=10, folder='Inbox'):
    """Show recent messages from a folder (default: Inbox)."""
    imap = connect()
    imap.select(folder)

    status, data = imap.search(None, 'ALL')
    ids = data[0].split()
    recent = ids[-limit:] if len(ids) > limit else ids
    recent.reverse()  # Most recent first

    messages = []
    for msg_id in recent:
        status, msg_data = imap.fetch(msg_id, '(FLAGS BODY.PEEK[HEADER])')
        raw = msg_data[0][1]
        flags = msg_data[0][0].decode()
        is_seen = '\\Seen' in flags
        env = parse_envelope(raw, msg_id.decode())
        env['isRead'] = is_seen
        messages.append(env)

    imap.logout()

    label = folder.lower()
    if JSON_OUTPUT:
        print(json.dumps(messages))
    else:
        print(f'## {folder} — outlook ({len(messages)} messages)\n')
        for i, env in enumerate(messages):
            unread_tag = '' if env['isRead'] else '[UNREAD] '
            print(f'{i+1}. {unread_tag}From: {env["from"]}')
            print(f'   Subject: {env["subject"]}')
            print(f'   Date: {env["date"]}')
            print(f'   ID: {env["id"]}\n')

def cmd_unread(limit=10):
    """Show unread messages only."""
    imap = connect()
    imap.select('Inbox')

    status, data = imap.search(None, 'UNSEEN')
    ids = data[0].split()
    recent = ids[-limit:] if len(ids) > limit else ids
    recent.reverse()

    messages = []
    for msg_id in recent:
        status, msg_data = imap.fetch(msg_id, '(BODY.PEEK[HEADER])')
        raw = msg_data[0][1]
        env = parse_envelope(raw, msg_id.decode())
        env['isRead'] = False
        messages.append(env)

    imap.logout()

    if JSON_OUTPUT:
        print(json.dumps(messages))
    else:
        print(f'## Unread — outlook ({len(messages)} messages)\n')
        for i, env in enumerate(messages):
            print(f'{i+1}. [UNREAD] From: {env["from"]}')
            print(f'   Subject: {env["subject"]}')
            print(f'   Date: {env["date"]}')
            print(f'   ID: {env["id"]}\n')

def cmd_read(msg_id):
    """Read a specific email and mark as read."""
    imap = connect()
    imap.select('Inbox')

    status, msg_data = imap.fetch(msg_id.encode(), '(RFC822)')
    if status != 'OK' or not msg_data[0]:
        if JSON_OUTPUT:
            print(json.dumps({'error': f'Message {msg_id} not found'}))
        else:
            print(f'ERROR: Message {msg_id} not found')
        imap.logout()
        sys.exit(1)

    raw = msg_data[0][1]
    env = parse_envelope(raw, msg_id)
    body = get_body(raw)

    # Auto-mark as read
    imap.store(msg_id.encode(), '+FLAGS', '\\Seen')
    imap.logout()

    if JSON_OUTPUT:
        env['isRead'] = True
        env['body'] = body
        print(json.dumps(env))
    else:
        print('## Email\n')
        print(f'From: {env["from"]}')
        print(f'Subject: {env["subject"]}')
        print(f'Date: {env["date"]}')
        print(f'\n---\n')
        print(body)

def cmd_mark_read(msg_id):
    """Mark a single email as read."""
    imap = connect()
    imap.select('Inbox')
    imap.store(msg_id.encode(), '+FLAGS', '\\Seen')
    imap.logout()
    print('Marked as read')

def cmd_mark_all_read():
    """Mark all unread inbox emails as read."""
    imap = connect()
    imap.select('Inbox')

    status, data = imap.search(None, 'UNSEEN')
    ids = data[0].split()

    if not ids:
        print('No unread emails to mark.')
        imap.logout()
        return

    for msg_id in ids:
        imap.store(msg_id, '+FLAGS', '\\Seen')

    print(f'Marked {len(ids)} email(s) as read')
    imap.logout()

def cmd_search(query, limit=10):
    """Search emails by subject or from."""
    imap = connect()
    imap.select('Inbox')

    # Search in subject and from
    status, data = imap.search(None, f'(OR SUBJECT "{query}" FROM "{query}")')
    ids = data[0].split()
    recent = ids[-limit:] if len(ids) > limit else ids
    recent.reverse()

    messages = []
    for msg_id in recent:
        status, msg_data = imap.fetch(msg_id, '(FLAGS BODY.PEEK[HEADER])')
        raw = msg_data[0][1]
        flags = msg_data[0][0].decode()
        is_seen = '\\Seen' in flags
        env = parse_envelope(raw, msg_id.decode())
        env['isRead'] = is_seen
        messages.append(env)

    imap.logout()

    if JSON_OUTPUT:
        print(json.dumps(messages))
    else:
        print(f'## Search — outlook: "{query}" ({len(messages)} results)\n')
        for i, env in enumerate(messages):
            print(f'{i+1}. From: {env["from"]}')
            print(f'   Subject: {env["subject"]}')
            print(f'   Date: {env["date"]}')
            print(f'   ID: {env["id"]}\n')

def cmd_folders():
    """List available IMAP folders."""
    imap = connect()

    status, folder_data = imap.list()
    if status != 'OK':
        if JSON_OUTPUT:
            print(json.dumps({'error': 'Failed to list folders'}))
        else:
            print('ERROR: Failed to list folders')
        imap.logout()
        sys.exit(1)

    folders = []
    for item in folder_data:
        # Format varies: b'(\\Flags) "/" "Quoted Name"' or b'(\\Flags) "/" Unquoted'
        decoded = item.decode()
        # Split on ' "/" ' to separate flags from folder name
        parts = decoded.split(' "/" ', 1)
        if len(parts) == 2:
            name = parts[1].strip('"')
        else:
            name = decoded.split()[-1].strip('"')
        folders.append(name)

    imap.logout()

    if JSON_OUTPUT:
        print(json.dumps(folders))
    else:
        print(f'## Folders — outlook ({len(folders)} folders)\n')
        for f in sorted(folders):
            print(f'  - {f}')

def cmd_move(msg_id, target_folder):
    """Move a message from Inbox to a target folder."""
    imap = connect()
    imap.select('Inbox')

    # Verify the message exists
    status, msg_data = imap.fetch(msg_id.encode(), '(FLAGS)')
    if status != 'OK' or not msg_data[0]:
        if JSON_OUTPUT:
            print(json.dumps({'error': f'Message {msg_id} not found'}))
        else:
            print(f'ERROR: Message {msg_id} not found')
        imap.logout()
        sys.exit(1)

    # Use COPY+DELETE approach (reliable across all IMAP servers and Python versions)
    moved = False

    if not moved:
        # Fallback: COPY to target, then flag deleted and expunge
        status, _ = imap.copy(msg_id.encode(), f'"{target_folder}"')
        if status != 'OK':
            if JSON_OUTPUT:
                print(json.dumps({'error': f'Failed to copy message to {target_folder}'}))
            else:
                print(f'ERROR: Failed to copy message to {target_folder}')
            imap.logout()
            sys.exit(1)
        imap.store(msg_id.encode(), '+FLAGS', '\\Deleted')
        imap.expunge()

    imap.logout()

    if JSON_OUTPUT:
        print(json.dumps({'ok': True, 'id': msg_id, 'folder': target_folder}))
    else:
        print(f'Moved message {msg_id} to {target_folder}')

def cmd_create_folder(folder_name):
    """Create a new IMAP folder."""
    imap = connect()

    status, data = imap.create(f'"{folder_name}"')
    imap.logout()

    if status != 'OK':
        error_msg = data[0].decode() if data and data[0] else 'Unknown error'
        if JSON_OUTPUT:
            print(json.dumps({'error': f'Failed to create folder: {error_msg}'}))
        else:
            print(f'ERROR: Failed to create folder: {error_msg}')
        sys.exit(1)

    if JSON_OUTPUT:
        print(json.dumps({'ok': True, 'folder': folder_name}))
    else:
        print(f'Created folder: {folder_name}')

def smtp_connect():
    """Connect to Outlook SMTP with XOAUTH2. Auto-refreshes expired tokens."""
    token = get_access_token()

    def try_smtp(tok):
        smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
        smtp.ehlo()
        smtp.starttls()
        smtp.ehlo()
        # XOAUTH2 auth string: base64("user=<user>\x01auth=Bearer <token>\x01\x01")
        auth_string = f'user={USER}\x01auth=Bearer {tok}\x01\x01'
        encoded = base64.b64encode(auth_string.encode()).decode()
        code, resp = smtp.docmd('AUTH', f'XOAUTH2 {encoded}')
        if code != 235:
            raise smtplib.SMTPAuthenticationError(code, resp)
        return smtp

    try:
        return try_smtp(token)
    except smtplib.SMTPAuthenticationError:
        # Access token expired — try refresh
        token = refresh_access_token()
        return try_smtp(token)

def cmd_send(to_addr, subject, body):
    """Send an email via Outlook SMTP."""
    msg = email.mime.text.MIMEText(body, 'plain', 'utf-8')
    msg['From'] = USER
    msg['To'] = to_addr
    msg['Subject'] = subject
    msg['Date'] = email.utils.formatdate(localtime=True)
    msg['Message-ID'] = email.utils.make_msgid(domain='outlook.com')

    smtp = smtp_connect()
    smtp.sendmail(USER, [to_addr], msg.as_string())
    smtp.quit()

    if JSON_OUTPUT:
        print(json.dumps({'ok': True, 'to': to_addr, 'subject': subject}))
    else:
        print(f'Sent email to {to_addr}: {subject}')

def cmd_reply(msg_id, body):
    """Reply to a specific email via Outlook SMTP."""
    # Fetch the original message to get headers for threading
    imap = connect()
    imap.select('Inbox')

    status, msg_data = imap.fetch(msg_id.encode(), '(RFC822)')
    if status != 'OK' or not msg_data[0]:
        if JSON_OUTPUT:
            print(json.dumps({'error': f'Message {msg_id} not found'}))
        else:
            print(f'ERROR: Message {msg_id} not found')
        imap.logout()
        sys.exit(1)

    original = email.message_from_bytes(msg_data[0][1])
    imap.logout()

    # Build reply headers for proper threading
    orig_from = decode_header(original.get('From', ''))
    orig_subject = decode_header(original.get('Subject', ''))
    orig_message_id = original.get('Message-ID', '')
    orig_references = original.get('References', '')

    # Extract reply-to address (use Reply-To if present, otherwise From)
    reply_to = original.get('Reply-To', original.get('From', ''))
    # Extract just the email address from "Name <email>" format
    parsed = email.utils.parseaddr(reply_to)
    to_addr = parsed[1] if parsed[1] else reply_to

    # Build subject with Re: prefix
    reply_subject = orig_subject
    if not reply_subject.lower().startswith('re:'):
        reply_subject = f'Re: {reply_subject}'

    # Build references chain
    references = orig_references
    if orig_message_id:
        references = f'{references} {orig_message_id}'.strip()

    msg = email.mime.text.MIMEText(body, 'plain', 'utf-8')
    msg['From'] = USER
    msg['To'] = to_addr
    msg['Subject'] = reply_subject
    msg['Date'] = email.utils.formatdate(localtime=True)
    msg['Message-ID'] = email.utils.make_msgid(domain='outlook.com')
    if orig_message_id:
        msg['In-Reply-To'] = orig_message_id
    if references:
        msg['References'] = references

    smtp = smtp_connect()
    smtp.sendmail(USER, [to_addr], msg.as_string())
    smtp.quit()

    if JSON_OUTPUT:
        print(json.dumps({'ok': True, 'to': to_addr, 'subject': reply_subject}))
    else:
        print(f'Replied to {orig_from}: {reply_subject}')

def main():
    global JSON_OUTPUT

    # Strip --json flag from args
    args = [a for a in sys.argv[1:] if a != '--json']
    if '--json' in sys.argv:
        JSON_OUTPUT = True

    if len(args) < 1:
        print('Usage: outlook-imap.py [--json] <command> [args]')
        print('Commands: inbox, unread, junk, read <id>, mark-read <id>, mark-all-read, search "query",')
        print('          folders, move <id> <folder>, create-folder <name>,')
        print('          send "to" "subject" "body", reply <id> "body"')
        sys.exit(1)

    cmd = args[0]

    if cmd in ('inbox', 'check'):
        cmd_inbox()
    elif cmd in ('junk', 'spam'):
        cmd_inbox(folder='Junk')
    elif cmd == 'unread':
        cmd_unread()
    elif cmd == 'read':
        if len(args) < 2:
            print('Usage: outlook-imap.py read <id>')
            sys.exit(1)
        cmd_read(args[1])
    elif cmd == 'mark-read':
        if len(args) < 2:
            print('Usage: outlook-imap.py mark-read <id>')
            sys.exit(1)
        cmd_mark_read(args[1])
    elif cmd == 'mark-all-read':
        cmd_mark_all_read()
    elif cmd == 'search':
        if len(args) < 2:
            print('Usage: outlook-imap.py search "query"')
            sys.exit(1)
        cmd_search(args[1])
    elif cmd == 'folders':
        cmd_folders()
    elif cmd == 'move':
        if len(args) < 3:
            print('Usage: outlook-imap.py move <id> <folder>')
            sys.exit(1)
        cmd_move(args[1], args[2])
    elif cmd == 'create-folder':
        if len(args) < 2:
            print('Usage: outlook-imap.py create-folder <name>')
            sys.exit(1)
        cmd_create_folder(args[1])
    elif cmd == 'send':
        if len(args) < 4:
            print('Usage: outlook-imap.py send "to" "subject" "body"')
            sys.exit(1)
        cmd_send(args[1], args[2], args[3])
    elif cmd == 'reply':
        if len(args) < 3:
            print('Usage: outlook-imap.py reply <id> "body"')
            sys.exit(1)
        cmd_reply(args[1], args[2])
    else:
        print(f'Unknown command: {cmd}')
        sys.exit(1)

if __name__ == '__main__':
    main()
