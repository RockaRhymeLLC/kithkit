# Microsoft Graph Email Integration

Use the Microsoft Graph API (client credentials flow) to read, search, send, and manage email in a Microsoft 365 mailbox without interactive sign-in.

## Prerequisites

- Microsoft 365 account with an accessible mailbox
- Azure portal access (`portal.azure.com`)
- Global Admin or Application Admin consent to grant app permissions
- Kithkit daemon running

## Setup

### 1. Register an Azure AD application

1. Go to **Azure Active Directory > App registrations > New registration**
2. Name it (e.g., `kithkit-graph-email`)
3. Supported account type: **Single tenant**
4. No redirect URI required for client credentials
5. Click **Register** and note the **Application (client) ID** and **Directory (tenant) ID**

### 2. Add API permissions

In **API permissions > Add a permission > Microsoft Graph > Application permissions**, add:

| Permission | Purpose |
|------------|---------|
| `Mail.ReadWrite` | Read and move messages |
| `Mail.Send` | Send messages |

Click **Grant admin consent** — all application permissions require it.

### 3. Create a client secret

**Certificates & secrets > New client secret**. Set an expiry (12 or 24 months). Copy the **Value** immediately — it is not shown again.

### 4. Store credentials in Keychain

```bash
security add-generic-password -s credential-graph-client-id     -a bmo -w "<CLIENT_ID>"
security add-generic-password -s credential-graph-client-secret  -a bmo -w "<CLIENT_SECRET>"
security add-generic-password -s credential-graph-tenant-id      -a bmo -w "<TENANT_ID>"
security add-generic-password -s credential-graph-mailbox        -a bmo -w "you@yourdomain.com"
```

## Configuration

```yaml
extensions:
  email:
    enabled: true
    provider: graph
    graph:
      client_id_credential:     credential-graph-client-id
      client_secret_credential: credential-graph-client-secret
      tenant_id_credential:     credential-graph-tenant-id
      mailbox_credential:       credential-graph-mailbox
      token_cache_ttl_seconds:  3500   # slightly under the 3600s token lifetime
      max_results:              25
```

## Key Reference Code

### GraphEmailProvider (TypeScript)

```typescript
// providers/graph-email-provider.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class GraphEmailProvider implements EmailProvider {
  private cache: TokenCache | null = null;

  constructor(private readonly cfg: GraphConfig) {}

  // --- Auth ---

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now + 60_000) {
      return this.cache.token;
    }

    const [clientId, clientSecret, tenantId] = await Promise.all([
      this.readCredential(this.cfg.client_id_credential),
      this.readCredential(this.cfg.client_secret_credential),
      this.readCredential(this.cfg.tenant_id_credential),
    ]);

    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    });

    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) throw new Error(`Token fetch failed: ${await res.text()}`);

    const data = await res.json() as { access_token: string; expires_in: number };
    this.cache = {
      token:     data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.cache.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getToken()}`,
      'Content-Type': 'application/json',
    };
  }

  private async readCredential(name: string): Promise<string> {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-s', name, '-w',
    ]);
    return stdout.trim();
  }

  private get baseUrl(): string {
    return `https://graph.microsoft.com/v1.0/users/${this.mailbox}`;
  }

  private mailbox = ''; // populated lazily on first call

  private async ensureMailbox(): Promise<void> {
    if (!this.mailbox) {
      this.mailbox = await this.readCredential(this.cfg.mailbox_credential);
    }
  }

  // --- EmailProvider interface ---

  async listInbox(options?: { maxResults?: number; unreadOnly?: boolean }): Promise<Email[]> {
    await this.ensureMailbox();
    const max = options?.maxResults ?? this.cfg.max_results ?? 25;
    const filter = options?.unreadOnly ? '&$filter=isRead eq false' : '';
    const url = `${this.baseUrl}/mailFolders/Inbox/messages?$top=${max}&$orderby=receivedDateTime desc${filter}`;

    const res = await fetch(url, { headers: await this.authHeaders() });
    if (!res.ok) throw new Error(`listInbox failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { value: GraphMessage[] };
    return data.value.map(graphToEmail);
  }

  async readEmail(id: string): Promise<Email> {
    await this.ensureMailbox();
    const res = await fetch(`${this.baseUrl}/messages/${id}`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw new Error(`readEmail failed: ${res.status}`);
    return graphToEmail(await res.json() as GraphMessage);
  }

  async markAsRead(id: string): Promise<void> {
    await this.ensureMailbox();
    await fetch(`${this.baseUrl}/messages/${id}`, {
      method:  'PATCH',
      headers: await this.authHeaders(),
      body:    JSON.stringify({ isRead: true }),
    });
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    await this.ensureMailbox();
    await fetch(`${this.baseUrl}/messages/${id}/move`, {
      method:  'POST',
      headers: await this.authHeaders(),
      body:    JSON.stringify({ destinationId: folder }),
    });
  }

  async searchEmails(query: string): Promise<Email[]> {
    await this.ensureMailbox();
    const encoded = encodeURIComponent(`"${query}"`);
    const url = `${this.baseUrl}/messages?$search=${encoded}&$top=20`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (!res.ok) throw new Error(`searchEmails failed: ${res.status}`);
    const data = await res.json() as { value: GraphMessage[] };
    return data.value.map(graphToEmail);
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    await this.ensureMailbox();
    await fetch(`${this.baseUrl}/sendMail`, {
      method:  'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        message: {
          subject,
          toRecipients: [{ emailAddress: { address: to } }],
          body: { contentType: 'Text', content: body },
        },
      }),
    });
  }
}

// --- Mapping helper ---

function graphToEmail(m: GraphMessage): Email {
  return {
    id:        m.id,
    subject:   m.subject ?? '(no subject)',
    from:      m.from?.emailAddress?.address ?? '',
    to:        m.toRecipients?.map(r => r.emailAddress.address) ?? [],
    date:      m.receivedDateTime,
    body:      m.body?.content ?? '',
    isRead:    m.isRead,
    folderId:  m.parentFolderId,
  };
}
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `AADSTS700016: Application not found` | Wrong client ID or wrong tenant | Double-check the App registration's **Application ID** and **Tenant ID** |
| `AADSTS7000215: Invalid client secret` | Secret expired or copied incorrectly | Rotate the secret in Azure portal; re-store in Keychain |
| `403 Forbidden` on mail endpoints | Admin consent not granted | In Azure portal, click **Grant admin consent for [tenant]** |
| `404` on mailbox URL | Mailbox UPN in Keychain doesn't match licensed M365 user | Confirm UPN with `GET /v1.0/users` |
| Token expires mid-session | Cache TTL too long | Set `token_cache_ttl_seconds` to 3500 (5-minute buffer before 3600s expiry) |
| `$search` returns nothing | Graph search indexes with delay | Wait ~30s after new mail arrives; use `$filter` for exact matches |
