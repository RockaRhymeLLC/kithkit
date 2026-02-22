/**
 * Kithkit Client — Local Type Declarations
 *
 * These mirror the types in @kithkit/catalog but are declared locally to avoid
 * cross-package runtime dependencies. Types are erased at runtime by
 * --experimental-strip-types, so we can't import them from the catalog package.
 */

export interface SkillVersion {
  version: string;
  archive: string;
  sha256: string;
  signature: string;
  size: number;
  published: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  author: {
    name: string;
    github: string;
  };
  capabilities: {
    required: string[];
    optional?: string[];
  };
  tags: string[];
  category: string;
  trust_level: 'first-party' | 'verified' | 'community';
  latest: string;
  versions: Record<string, SkillVersion>;
}

export interface SignedCatalogIndex {
  version: number;
  updated: string;
  skills: SkillEntry[];
  signature: string;
}

export interface SearchQuery {
  text?: string;
  tag?: string;
  capability?: string;
}

export interface SearchResult {
  name: string;
  description: string;
  version: string;
  trust_level: 'first-party' | 'verified' | 'community';
  capabilities: { required: string[]; optional?: string[] };
  tags: string[];
  author: { name: string; github: string };
}

export interface CachedIndex {
  fetchedAt: number;
  index: SignedCatalogIndex;
}

export interface KithkitMetadata {
  name: string;
  version: string;
  source: string;        // catalog URL or archive path
  sha256: string;        // archive hash
  signature: string;     // archive signature
  installed_at: string;  // ISO 8601
  trust_level: 'first-party' | 'verified' | 'community';
}

export interface RevocationEntry {
  name: string;
  version: string;
  reason: string;
  revoked_at: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface SignedRevocationList {
  entries: RevocationEntry[];
  signature: string;
}

export interface InstallResult {
  success: boolean;
  skillName: string;
  version: string;
  installDir: string;
  error?: string;
}

export interface UpdateCheckResult {
  skillName: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  changelog?: string;  // diff between versions if available
}

export interface UninstallResult {
  success: boolean;
  skillName: string;
  configBackedUp: boolean;
  error?: string;
}

export interface ListEntry {
  name: string;
  version: string;
  trust_level: 'first-party' | 'verified' | 'community';
  source: string;
  installed_at: string;
  hasUpdate: boolean;
  latestVersion?: string;
}
