/**
 * Signing Bridge — thin wrapper around node:crypto for Ed25519 operations.
 *
 * This avoids a runtime dependency on @kithkit/sign while using the same
 * Ed25519 PKCS8/SPKI DER format for compatibility.
 */

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';

export function signData(data: Buffer, privateKeyBase64: string): string {
  const keyObject = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = cryptoSign(null, data, keyObject);
  return signature.toString('base64');
}

export function verifyData(data: Buffer, signatureBase64: string, publicKeyBase64: string): boolean {
  const keyObject = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const signatureBuffer = Buffer.from(signatureBase64, 'base64');
  return cryptoVerify(null, data, keyObject, signatureBuffer);
}

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}
