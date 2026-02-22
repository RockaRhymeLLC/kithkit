import { createPublicKey, verify as cryptoVerify, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function verifyData(data: Buffer, signatureBase64: string, publicKeyBase64: string): boolean {
  const keyObject = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const signatureBuffer = Buffer.from(signatureBase64, 'base64');
  return cryptoVerify(null, data, keyObject, signatureBuffer);
}

export async function verifyFile(
  filePath: string,
  signatureBase64: string,
  publicKeyBase64: string
): Promise<boolean> {
  const fileData = await readFile(filePath);
  const hash = createHash('sha256').update(fileData).digest();
  return verifyData(hash, signatureBase64, publicKeyBase64);
}
