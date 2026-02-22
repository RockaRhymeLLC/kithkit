/**
 * Credential Access Patterns
 *
 * Detect unauthorized access to credentials, keys, and secrets.
 */

import type { SecurityPattern } from './prompt-injection.ts';

export const CREDENTIAL_ACCESS_PATTERNS: SecurityPattern[] = [
  {
    id: 'credential/keychain-access',
    description: 'macOS Keychain credential access',
    pattern: /security\s+find-generic-password/i,
    severity: 'error',
  },
  {
    id: 'credential/keychain-dump',
    description: 'Keychain dump or export',
    pattern: /security\s+(?:dump-keychain|export)/i,
    severity: 'error',
  },
  {
    id: 'credential/ssh-key-read',
    description: 'Direct SSH key file access',
    pattern: /(?:cat|read|open|less|more|head|tail)\s+~?\/?\.ssh\/(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys)/i,
    severity: 'error',
  },
  {
    id: 'credential/ssh-dir-read',
    description: 'SSH directory file access (config, known_hosts, or other sensitive files)',
    pattern: /(?:cat|read|open|less|more|head|tail)\s+~?\/?\.ssh\/(?:config|known_hosts|environment)/i,
    severity: 'warning',
  },
  {
    id: 'credential/env-var-exfil',
    description: 'Sending environment variable credentials to external endpoint',
    pattern: /(?:send|post|curl|fetch|wget)\s+.*\$(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i,
    severity: 'error',
  },
  {
    id: 'credential/aws-credentials',
    description: 'AWS credentials file access',
    pattern: /(?:cat|read|open)\s+~?\/?\.aws\/credentials/i,
    severity: 'error',
  },
  {
    id: 'credential/env-file-read',
    description: 'Reading .env files (may contain secrets)',
    pattern: /(?:cat|read|source|\.)\s+\.env(?:\.local|\.production|\.staging)?(?:\s|$)/i,
    severity: 'warning',
  },
  {
    id: 'credential/token-harvest',
    description: 'Broad credential harvesting patterns',
    pattern: /(?:collect|gather|harvest|extract)\s+(?:all\s+)?(?:tokens?|credentials?|secrets?|keys?|passwords?)/i,
    severity: 'error',
  },
];
