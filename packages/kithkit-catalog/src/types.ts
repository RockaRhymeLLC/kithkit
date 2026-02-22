/**
 * Kithkit Catalog — Core Types
 *
 * Data model for catalog index, skill entries, and archive metadata.
 */

export interface SkillVersion {
  version: string;
  archive: string;       // relative path: archives/{name}/{name}-{version}.tar.gz
  sha256: string;        // hex-encoded SHA-256 of archive
  signature: string;     // base64 Ed25519 signature of archive hash
  size: number;          // archive size in bytes
  published: string;     // ISO 8601 timestamp
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
  latest: string;        // latest version string
  versions: Record<string, SkillVersion>;
}

export interface CatalogIndex {
  version: number;       // schema version
  updated: string;       // ISO 8601 timestamp
  skills: SkillEntry[];  // sorted by name for determinism
}

export interface SignedCatalogIndex {
  version: number;
  updated: string;
  skills: SkillEntry[];
  signature: string;     // Ed25519 signature of canonical JSON of {version, updated, skills}
}

export interface RevocationEntry {
  name: string;
  version: string;
  reason: string;
  revoked_at: string;    // ISO 8601
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface SignedRevocationList {
  entries: RevocationEntry[];
  signature: string;
}

export interface ArchiveInfo {
  name: string;
  version: string;
  path: string;
  sha256: string;
  size: number;
}
