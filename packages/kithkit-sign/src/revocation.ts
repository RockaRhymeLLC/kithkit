import { signData } from './sign.ts';
import { verifyData } from './verify.ts';
import { canonicalJson } from './canonical.ts';

export interface SignedRevocationList {
  entries: object[];
  signature: string;
}

export function signRevocationList(
  list: object,
  privateKeyBase64: string
): SignedRevocationList {
  const entries = (list as { entries?: object[] }).entries ?? (list as object[]);
  const canonical = canonicalJson(entries);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, privateKeyBase64);
  return { entries: Array.isArray(entries) ? entries : [], signature };
}

export function verifyRevocationList(
  signedList: SignedRevocationList,
  publicKeyBase64: string
): boolean {
  const canonical = canonicalJson(signedList.entries);
  const data = Buffer.from(canonical, 'utf8');
  return verifyData(data, signedList.signature, publicKeyBase64);
}
