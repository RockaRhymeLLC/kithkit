/**
 * Network registration — identity setup + relay registration.
 *
 * One-time setup flow:
 * 1. Generate Ed25519 keypair (or load existing from Keychain)
 * 2. Register with relay service(s)
 * 3. Check registration status
 *
 * Supports single-relay (relay_url) and multi-community (communities[]).
 */

import { createLogger } from '../../../core/logger.js';
import { readKeychain } from '../../../core/keychain.js';
import {
  createPrivateKey,
  createHash,
  sign as cryptoSign,
} from 'node:crypto';
import {
  generateAndStoreIdentity,
  loadKeyFromKeychain,
  derivePublicKey,
} from './crypto.js';
import type { R2Config, NetworkCommunity } from '../../config.js';

const log = createLogger('network:registration');

export interface RegistrationResult {
  ok: boolean;
  status?: string;
  message?: string;
  error?: string;
}

/**
 * Ensure the agent has a network identity.
 * Generates keypair on first run, loads from Keychain on subsequent runs.
 */
export async function ensureIdentity(): Promise<{ publicKey: string; privateKey: string } | null> {
  const generated = await generateAndStoreIdentity();
  if (generated) return generated;

  const privateKey = await loadKeyFromKeychain();
  if (!privateKey) {
    log.error('No agent identity found and generation failed');
    return null;
  }

  return {
    publicKey: derivePublicKey(privateKey),
    privateKey,
  };
}

/**
 * Build authenticated request headers for relay API calls.
 */
function buildAuthHeaders(
  method: string,
  path: string,
  agentName: string,
  privateKeyBase64: string,
  body: string = '',
): Record<string, string> {
  const ts = new Date().toISOString();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sigStr = `${method} ${path}\n${ts}\n${bodyHash}`;
  const privKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = cryptoSign(null, Buffer.from(sigStr), privKey).toString('base64');
  return {
    'Authorization': `Signature ${agentName}:${sig}`,
    'X-Timestamp': ts,
  };
}

async function registerOnRelay(
  relayUrl: string,
  agentName: string,
  publicKey: string,
  ownerEmail?: string,
  privateKeyBase64?: string,
): Promise<RegistrationResult> {
  // Check if already registered
  if (privateKeyBase64) {
    try {
      const path = `/registry/agents/${agentName}`;
      const headers = buildAuthHeaders('GET', path, agentName, privateKeyBase64);
      const checkResp = await fetch(`${relayUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (checkResp.ok) {
        const agent = await checkResp.json() as { status: string };
        if (agent.status === 'active') {
          return { ok: true, status: 'active' };
        }
      }
    } catch {
      // Check failed — proceed with registration
    }
  }

  const body = {
    name: agentName,
    publicKey,
    ownerEmail: ownerEmail || undefined,
  };

  try {
    const response = await fetch(`${relayUrl}/registry/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json() as {
      name?: string;
      status?: string;
      message?: string;
      error?: string;
    };

    if (response.status === 201) {
      return { ok: true, status: data.status, message: data.message };
    }

    if (response.status === 409) {
      return { ok: true, status: 'active' };
    }

    return { ok: false, error: data.error || `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register with relay service(s).
 * Single-relay or multi-community. Returns ok if at least one succeeded.
 */
export async function registerWithRelay(config: R2Config): Promise<RegistrationResult> {
  const network = config.network;

  if (!network?.enabled) {
    return { ok: false, error: 'Network not enabled' };
  }

  if (!network.communities?.length) {
    return { ok: false, error: 'No communities configured' };
  }

  const identity = await ensureIdentity();
  if (!identity) {
    return { ok: false, error: 'No agent identity available' };
  }

  const agentName = config.agent.name.toLowerCase();

  return registerMultiCommunity(network.communities, agentName, identity, network.owner_email);
}

async function registerMultiCommunity(
  communities: NetworkCommunity[],
  agentName: string,
  defaultIdentity: { publicKey: string; privateKey: string },
  ownerEmail?: string,
): Promise<RegistrationResult> {
  let succeeded = 0;
  let total = 0;

  for (const community of communities) {
    let publicKey = defaultIdentity.publicKey;
    let privateKey = defaultIdentity.privateKey;

    // Per-community keypair support (from Keychain)
    if ((community as unknown as Record<string, unknown>).keypair) {
      const keypairName = (community as unknown as Record<string, unknown>).keypair as string;
      const keyBase64 = await readKeychain(keypairName);
      if (keyBase64) {
        publicKey = derivePublicKey(keyBase64);
        privateKey = keyBase64;
      } else {
        log.warn(`Community '${community.name}': keypair '${keypairName}' not in Keychain, using default`);
      }
    }

    // Primary
    total++;
    log.info(`Registering on community '${community.name}' primary...`);
    const primaryResult = await registerOnRelay(community.primary, agentName, publicKey, ownerEmail, privateKey);
    if (primaryResult.ok) {
      succeeded++;
      log.info(`Community '${community.name}' primary: registered (${primaryResult.status})`);
    } else {
      log.warn(`Community '${community.name}' primary: failed — ${primaryResult.error}`);
    }

    // Failover
    if (community.failover) {
      total++;
      log.info(`Registering on community '${community.name}' failover...`);
      const failoverResult = await registerOnRelay(community.failover, agentName, publicKey, ownerEmail, privateKey);
      if (failoverResult.ok) {
        succeeded++;
        log.info(`Community '${community.name}' failover: registered (${failoverResult.status})`);
      } else {
        log.warn(`Community '${community.name}' failover: failed — ${failoverResult.error}`);
      }
    }
  }

  log.info(`Multi-community registration complete: ${succeeded}/${total} relays`);

  return {
    ok: succeeded > 0,
    status: succeeded === total ? 'active' : 'partial',
    message: `${succeeded}/${total} relays registered`,
  };
}

export async function checkRegistrationStatus(config: R2Config): Promise<RegistrationResult> {
  const network = config.network;

  if (!network?.enabled) {
    return { ok: false, error: 'Network not enabled' };
  }

  const agentName = config.agent.name.toLowerCase();

  let relayUrl: string;
  if (network.communities?.length) {
    relayUrl = network.communities[0].primary;
  } else {
    return { ok: false, error: 'No relay configured' };
  }

  try {
    const response = await fetch(`${relayUrl}/registry/agents/${agentName}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return { ok: false, status: 'unregistered', error: 'Agent not found in directory' };
    }
    if (!response.ok) {
      return { ok: false, error: `Status check failed: HTTP ${response.status}` };
    }

    const agent = await response.json() as { name: string; status: string };
    return { ok: true, status: agent.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to check status: ${message}` };
  }
}
