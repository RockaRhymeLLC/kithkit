/**
 * Keychain bridge for network agent identity (Ed25519).
 *
 * Crypto primitives (sign, verify, encrypt) live in the cc4me-network SDK —
 * this module only manages key storage and identity lifecycle.
 *
 * v2 difference: keychain is async (readKeychain/writeKeychain return Promises).
 */

import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'node:crypto';
import { readKeychain, writeKeychain } from '../../../core/keychain.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger('network:crypto');

const AGENT_KEY_SERVICE = 'credential-cc4me-agent-key';

export interface Keypair {
  publicKey: string;
  privateKey: string;
}

export async function storeKeyInKeychain(privateKeyBase64: string): Promise<void> {
  await writeKeychain(AGENT_KEY_SERVICE, 'assistant', privateKeyBase64);
  log.info('Agent private key stored in Keychain');
}

export async function loadKeyFromKeychain(): Promise<string | null> {
  return readKeychain(AGENT_KEY_SERVICE);
}

export function derivePublicKey(privateKeyBase64: string): string {
  const privKeyObj = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKeyObj = createPublicKey(privKeyObj);
  const pubDer = pubKeyObj.export({ type: 'spki', format: 'der' });
  return Buffer.from(pubDer).toString('base64');
}

export async function hasIdentity(): Promise<boolean> {
  return (await loadKeyFromKeychain()) !== null;
}

export async function generateAndStoreIdentity(): Promise<Keypair | null> {
  if (await hasIdentity()) {
    log.info('Agent identity already exists in Keychain, skipping generation');
    return null;
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' });

  const keypair: Keypair = {
    publicKey: Buffer.from(pubRaw).toString('base64'),
    privateKey: Buffer.from(privRaw).toString('base64'),
  };

  await storeKeyInKeychain(keypair.privateKey);
  log.info('Generated new Ed25519 identity and stored in Keychain');
  return keypair;
}
