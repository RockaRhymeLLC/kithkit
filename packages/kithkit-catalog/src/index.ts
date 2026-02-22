export { buildIndex, updateIndex, verifySignedIndex, serializeIndex, canonicalJson } from './index-builder.ts';
export type { BuildIndexOptions } from './index-builder.ts';

export { createArchive, hashArchive, extractManifestFromArchive } from './archive.ts';

export { signData, verifyData, generateKeyPair } from './signing-bridge.ts';

export {
  createRevocationList,
  verifyRevocationList,
  isRevoked,
  checkInstalledRevocations,
} from './revocation.ts';

export type {
  CatalogIndex,
  SignedCatalogIndex,
  SkillEntry,
  SkillVersion,
  RevocationEntry,
  SignedRevocationList,
  ArchiveInfo,
} from './types.ts';
