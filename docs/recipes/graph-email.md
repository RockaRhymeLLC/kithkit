# Recipe: Microsoft Graph Email Integration

Connect your Kithkit agent to a Microsoft 365 mailbox using the Microsoft Graph API. This gives the agent full read/write access to a mailbox: listing, reading, sending, moving, and searching email.

This recipe uses the **client credentials** (app-only) OAuth2 flow — no interactive login required once the Azure AD app is configured and admin consent is granted.

---

## Prerequisites

- A Microsoft 365 account (work, school, or personal with M365 subscription)
- Access to the Azure portal (`portal.azure.com`) to register an app
- Admin consent rights on the tenant (or a global admin who can grant them)
- Node.js 22+ (daemon runtime)
- The Kithkit daemon configured and running

---

## Setup Steps

### Step 1 — Register an Azure AD application

1. Sign in to [portal.azure.com](https://portal.azure.com)
2. Navigate to **Azure Active Directory** → **App registrations** → **New registration**
3. Name: `Kithkit Email` (or any name you'll recognize)
4. Supported account types: **Accounts in this organizational directory only** (single tenant)
5. Redirect URI: leave blank (not needed for client credentials flow)
6. Click **Register**

Note the **Application (client) ID** and **Directory (tenant) ID** from the overview page.

### Step 2 — Add API permissions

1. In your new app registration, go to **API permissions** → **Add a permission**
2. Choose **Microsoft Graph** → **Application permissions**
3. Add these permissions:
   - `Mail.ReadWrite` — read and modify mailbox messages
   - `Mail.Send` — send email as the mailbox user
4. Click **Add permissions**
5. Click **Grant admin consent for [your tenant]** and confirm

The permissions column should show a green checkmark and "Granted for [tenant]".

### Step 3 — Create a client secret

1. Go to **Certificates & secrets** → **New client secret**
2. Add a description (e.g., "kithkit-daemon") and choose an expiry (max 24 months on most tenants)
3. Copy the **Value** immediately — it will not be shown again after you leave the page

### Step 4 — Store credentials in Keychain

```bash
# Application (client) ID
security add-generic-password \
  -s credential-azure-client-id \
  -a kithkit \
  -w "YOUR_CLIENT_ID_HERE"

# Directory (tenant) ID
security add-generic-password \
  -s credential-azure-tenant-id \
  -a kithkit \
  -w "YOUR_TENANT_ID_HERE"

# Client secret value
security add-generic-password \
  -s credential-azure-client-secret \
  -a kithkit \
  -w "YOUR_CLIENT_SECRET_HERE"
```

Verify they stored:

```bash
security find-generic-password -s credential-azure-client-id -w
security find-generic-password -s credential-azure-tenant-id -w
```

### Step 5 — Set the mailbox user email

The Graph API app-only flow accesses a specific user's mailbox. Set the target email in your config (see Config Snippet below).

---

## Config Snippet

```yaml
channels:
  email:
    enabled: true
    providers:
      - type: "graph"
        user_email: "assistant@yourdomain.com"
        # Keychain keys (defaults shown — override if using different names)
        keychain:
          client_id: "credential-azure-client-id"
          tenant_id: "credential-azure-tenant-id"
          client_secret: "credential-azure-client-secret"
        # Optional tuning
        inbox_poll_interval_ms: 60000   # How often to check for new mail (if polling)
        max_list_results: 25            # Default page size for listInbox()
```

---

## Reference Code

### EmailProvider interface

All Kithkit email providers implement this shared interface. The Graph provider is one implementation; Himalaya, JMAP, and Outlook IMAP are others. Providers are registered in `channels.email.providers` and selected by the daemon at runtime.

```typescript
export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  to: string[];
  date: string;         // ISO 8601
  body: string;         // plain text (HTML stripped)
  bodyHtml?: string;    // raw HTML if available
  isRead: boolean;
  folder?: string;
}

export interface SendOptions {
  cc?: string[];
  bcc?: string[];
  replyToId?: string;   // message ID to reply to (sets In-Reply-To header)
  isHtml?: boolean;     // send body as HTML
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

### Graph provider implementation

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { EmailProvider, EmailMessage, SendOptions } from "./types.js";

const execFileAsync = promisify(execFile);

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0/users/{userEmail}/messages";

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

async function getSecret(keychainService: string): Promise<string> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s", keychainService,
    "-w",
  ]);
  return stdout.trim();
}

async function getAccessToken(
  clientId: string,
  tenantId: string,
  clientSecret: string
): Promise<string> {
  const BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

  if (tokenCache && Date.now() < tokenCache.expiresAt - BUFFER_MS) {
    return tokenCache.token;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(
    TOKEN_ENDPOINT.replace("{tenantId}", tenantId),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token request failed: ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return tokenCache.token;
}

export class GraphEmailProvider implements EmailProvider {
  name = "graph";

  constructor(
    private userEmail: string,
    private keychainClientId: string = "credential-azure-client-id",
    private keychainTenantId: string = "credential-azure-tenant-id",
    private keychainClientSecret: string = "credential-azure-client-secret"
  ) {}

  isConfigured(): boolean {
    // Lightweight check — just verifies keychain entries exist
    try {
      execFile("security", ["find-generic-password", "-s", this.keychainClientId]);
      return true;
    } catch {
      return false;
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const [clientId, tenantId, clientSecret] = await Promise.all([
      getSecret(this.keychainClientId),
      getSecret(this.keychainTenantId),
      getSecret(this.keychainClientSecret),
    ]);
    const token = await getAccessToken(clientId, tenantId, clientSecret);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  private baseUrl(): string {
    return GRAPH_BASE.replace("{userEmail}", this.userEmail);
  }

  async listInbox(limit = 25, unreadOnly = false): Promise<EmailMessage[]> {
    const headers = await this.authHeaders();
    let url = `${this.baseUrl()}?$top=${limit}&$orderby=receivedDateTime desc`;
    if (unreadOnly) url += "&$filter=isRead eq false";

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Graph listInbox failed: ${res.status}`);

    const data = (await res.json()) as { value: any[] };
    return data.value.map(mapMessage);
  }

  async readEmail(id: string): Promise<EmailMessage | null> {
    const headers = await this.authHeaders();
    const res = await fetch(`${this.baseUrl()}/${id}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Graph readEmail failed: ${res.status}`);
    return mapMessage(await res.json());
  }

  async markAsRead(id: string): Promise<void> {
    const headers = await this.authHeaders();
    await fetch(`${this.baseUrl()}/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ isRead: true }),
    });
  }

  async moveEmail(id: string, folder: string): Promise<void> {
    const headers = await this.authHeaders();
    // Resolve folder name to ID first if needed (omitted for brevity)
    await fetch(`${this.baseUrl()}/${id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ destinationId: folder }),
    });
  }

  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    const headers = await this.authHeaders();
    const encoded = encodeURIComponent(`"${query}"`);
    const url = `${this.baseUrl()}?$search=${encoded}&$top=${limit}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Graph searchEmails failed: ${res.status}`);
    const data = (await res.json()) as { value: any[] };
    return data.value.map(mapMessage);
  }

  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {}
  ): Promise<void> {
    const headers = await this.authHeaders();
    const contentType = options.isHtml ? "HTML" : "Text";

    const message: any = {
      subject,
      body: { contentType, content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    };

    if (options.cc?.length) {
      message.ccRecipients = options.cc.map((a) => ({ emailAddress: { address: a } }));
    }
    if (options.bcc?.length) {
      message.bccRecipients = options.bcc.map((a) => ({ emailAddress: { address: a } }));
    }

    const sendUrl = `https://graph.microsoft.com/v1.0/users/${this.userEmail}/sendMail`;
    const res = await fetch(sendUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Graph sendEmail failed: ${res.status} ${err}`);
    }
  }
}

function mapMessage(raw: any): EmailMessage {
  return {
    id: raw.id,
    subject: raw.subject ?? "(no subject)",
    from: raw.from?.emailAddress?.address ?? "",
    to: (raw.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
    date: raw.receivedDateTime,
    body: raw.body?.content ?? "",
    bodyHtml: raw.body?.contentType === "html" ? raw.body.content : undefined,
    isRead: raw.isRead ?? false,
    folder: raw.parentFolderId,
  };
}
```

---

## Troubleshooting

**`AADSTS700016: Application not found`**

- The client ID is wrong or the app was registered in a different tenant
- Double-check the tenant ID matches the directory where you registered the app
- Verify with: `security find-generic-password -s credential-azure-tenant-id -w`

**`AADSTS7000215: Invalid client secret`**

- The secret value may have been copied incorrectly (trailing whitespace is a common cause)
- Re-check the secret in Keychain: `security find-generic-password -s credential-azure-client-secret -w`
- If the secret has expired, create a new one in Azure portal and update Keychain

**`403 Forbidden` on API calls**

- Admin consent was not granted for the permissions
- Go to Azure portal → App registration → API permissions and click "Grant admin consent"
- Confirm the green checkmark appears next to `Mail.ReadWrite` and `Mail.Send`

**`404 Not Found` on user mailbox**

- The `user_email` in config does not match an actual mailbox in the tenant
- App-only permissions require the target user to have an active M365 license with a mailbox

**Token expires mid-session**

- The provider caches the token and refreshes automatically with a 5-minute buffer before expiry
- If you see auth errors after long idle periods, check that the system clock is correct (token validation is time-sensitive)

**Secret expiry — how to track it**

- Azure portal → App registration → Certificates & secrets shows the expiry date
- If your M365 tenant is managed by a third party (e.g., GoDaddy M365), you may need to log in to their portal to see app registrations
- Consider setting a calendar reminder 30 days before expiry to rotate the secret
