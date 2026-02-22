import { signData } from './sign.ts';
import { verifyData } from './verify.ts';
import { canonicalJson } from './canonical.ts';

export interface SignedIndex {
  index: object;
  signature: string;
}

export function signIndex(indexObj: object, privateKeyBase64: string): SignedIndex {
  const canonical = canonicalJson(indexObj);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, privateKeyBase64);
  return { index: indexObj, signature };
}

export function verifyIndex(signedIndex: SignedIndex, publicKeyBase64: string): boolean {
  const canonical = canonicalJson(signedIndex.index);
  const data = Buffer.from(canonical, 'utf8');
  return verifyData(data, signedIndex.signature, publicKeyBase64);
}
