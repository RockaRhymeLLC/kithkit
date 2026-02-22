import { generateKeyPairSync } from 'node:crypto';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateCatalogAuthority(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}
