export { generateConfig, mergeConfig } from './config.ts';
export type { ConfigField, GeneratedConfig, ConfigFieldInfo, ConfigMergeResult } from './config.ts';

export { CatalogCache, verifyAndParseIndex, searchCatalog, formatSearchResults } from './search.ts';
export type { VerifyResult, VerifySuccess, VerifyFailure } from './search.ts';

export {
  verifyArchiveIntegrity,
  extractArchive,
  writeMetadata,
  readMetadata,
  installSkill,
  verifyRevocationList,
  isRevoked,
} from './install.ts';
export type {
  ArchiveIntegrityResult,
  IntegrityResult,
  IntegrityFailure,
  InstallOptions,
} from './install.ts';

export {
  REVIEW_RUBRIC,
  buildReviewContext,
  createReviewReport,
  formatReviewForHuman,
  getReviewPrompt,
  getRiskLevel,
} from './review.ts';
export type {
  ReviewRubric,
  ReviewFinding,
  ReviewReport,
  ReviewContext,
} from './review.ts';

export {
  checkForUpdate,
  updateSkill,
  checkAllUpdates,
  uninstallSkill,
  listInstalled,
  restoreConfigBackup,
} from './lifecycle.ts';
export type { UpdateOptions } from './lifecycle.ts';

export {
  getTestCases,
  runSelftest,
  patternBasedReview,
  formatSelftestReport,
} from './selftest.ts';
export type {
  AdversarialTestCase,
  SelftestResult,
  SelftestSummary,
} from './selftest.ts';

export type {
  SignedCatalogIndex,
  SkillEntry,
  SkillVersion,
  SearchQuery,
  SearchResult,
  CachedIndex,
  KithkitMetadata,
  RevocationEntry,
  SignedRevocationList,
  InstallResult,
  UpdateCheckResult,
  UninstallResult,
  ListEntry,
} from './types.ts';
