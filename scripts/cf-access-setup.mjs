/**
 * Set up Cloudflare Access for marvbot.marvho.ai
 *
 * Strategy: Create separate Access apps for bypass paths (no auth needed),
 * then a catch-all app for the domain that requires authentication.
 * More specific path apps take precedence over the domain-level app.
 */
import { readKeychain } from '../daemon/dist/core/keychain.js';

const ACCOUNT_ID = 'ecde9f91f1378fe6a66b079eb5a06342';
const DOMAIN = 'marvbot.marvho.ai';

// Paths that should be publicly accessible (webhooks, health check, P2P)
const BYPASS_PATHS = [
  { name: 'Health Check', path: '/health' },
  { name: 'P2P Webhook', path: '/agent/p2p' },
  { name: 'Telegram Webhook', path: '/telegram' },
];

let _token = null;

async function getToken() {
  if (!_token) {
    _token = await readKeychain('credential-cloudflare-api-token');
    if (!_token) throw new Error('CF API token not found in keychain');
  }
  return _token;
}

async function cfApi(path, options = {}) {
  const token = await getToken();
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await resp.json();
  if (!data.success) {
    console.error('CF API error:', JSON.stringify(data.errors, null, 2));
    throw new Error(`CF API failed: ${data.errors?.[0]?.message || resp.status}`);
  }
  return data;
}

async function deleteApp(appId, appName) {
  console.log(`   Deleting existing app: ${appName} (${appId})`);
  await cfApi(`/accounts/${ACCOUNT_ID}/access/apps/${appId}`, { method: 'DELETE' });
}

async function main() {
  // Step 1: Verify token
  console.log('1. Verifying API token...');
  const verify = await cfApi('/user/tokens/verify');
  console.log('   Token status:', verify.result.status);

  // Step 2: Clean up existing marvbot Access apps
  console.log('2. Checking existing Access apps...');
  const apps = await cfApi(`/accounts/${ACCOUNT_ID}/access/apps`);
  const marvbotApps = apps.result?.filter(a => a.domain === DOMAIN) || [];
  if (marvbotApps.length > 0) {
    console.log(`   Found ${marvbotApps.length} existing app(s) — removing...`);
    for (const app of marvbotApps) {
      await deleteApp(app.id, app.name);
    }
  }

  // Step 3: Create bypass apps for open paths
  console.log('3. Creating bypass apps for open paths...');
  for (const { name, path } of BYPASS_PATHS) {
    const app = await cfApi(`/accounts/${ACCOUNT_ID}/access/apps`, {
      method: 'POST',
      body: JSON.stringify({
        name: `Marvbot - ${name}`,
        domain: `${DOMAIN}${path}`,
        type: 'self_hosted',
        session_duration: '24h',
      }),
    });
    const appId = app.result.id;

    // Add bypass policy
    await cfApi(`/accounts/${ACCOUNT_ID}/access/apps/${appId}/policies`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Public bypass',
        decision: 'bypass',
        precedence: 1,
        include: [{ everyone: {} }],
      }),
    });
    console.log(`   ${name} (${path}) — bypass created`);
  }

  // Step 4: Create main Access app for the domain (catch-all, requires auth)
  console.log('4. Creating main Access app (requires auth)...');
  const mainApp = await cfApi(`/accounts/${ACCOUNT_ID}/access/apps`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Marvbot API (Protected)',
      domain: DOMAIN,
      type: 'self_hosted',
      session_duration: '24h',
      auto_redirect_to_identity: false,
    }),
  });
  const mainAppId = mainApp.result.id;
  console.log('   Created:', mainAppId);

  // Step 5: Add allow policy for servos.io emails (OTP)
  console.log('5. Creating email OTP allow policy...');
  await cfApi(`/accounts/${ACCOUNT_ID}/access/apps/${mainAppId}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Servos team - Email OTP',
      decision: 'allow',
      precedence: 1,
      include: [{ email_domain: { domain: 'servos.io' } }],
    }),
  });
  console.log('   Allow policy for @servos.io created');

  // Step 6: Add service token policy (for programmatic access)
  console.log('6. Creating service token policy...');
  await cfApi(`/accounts/${ACCOUNT_ID}/access/apps/${mainAppId}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Service Token Access',
      decision: 'non_identity',
      precedence: 2,
      include: [{ any_valid_service_token: {} }],
    }),
  });
  console.log('   Service token policy created');

  console.log('\n=== Done! ===');
  console.log('Bypass paths:', BYPASS_PATHS.map(p => p.path).join(', '));
  console.log('Protected: everything else on', DOMAIN);
  console.log('Auth methods: Email OTP (@servos.io), Service Tokens');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
