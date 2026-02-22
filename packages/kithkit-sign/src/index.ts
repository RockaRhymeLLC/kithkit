export { generateCatalogAuthority } from './keygen.ts';
export type { KeyPair } from './keygen.ts';

export { signData, signFile } from './sign.ts';

export { verifyData, verifyFile } from './verify.ts';

export { signIndex, verifyIndex } from './index-signer.ts';
export type { SignedIndex } from './index-signer.ts';

export { signRevocationList, verifyRevocationList } from './revocation.ts';
export type { SignedRevocationList } from './revocation.ts';

export { canonicalJson } from './canonical.ts';
