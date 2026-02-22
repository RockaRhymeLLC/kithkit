import { createPrivateKey, sign as cryptoSign, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function signData(data: Buffer, privateKeyBase64: string): string {
  const keyObject = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const signature = cryptoSign(null, data, keyObject);
  return signature.toString('base64');
}

export async function signFile(filePath: string, privateKeyBase64: string): Promise<string> {
  const fileData = await readFile(filePath);
  const hash = createHash('sha256').update(fileData).digest();
  return signData(hash, privateKeyBase64);
}
