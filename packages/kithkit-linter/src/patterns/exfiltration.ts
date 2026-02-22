/**
 * Exfiltration Patterns
 *
 * Detect data exfiltration via URLs, command substitution, and dynamic data transmission.
 */

import type { SecurityPattern } from './prompt-injection.ts';

export const EXFILTRATION_PATTERNS: SecurityPattern[] = [
  {
    id: 'exfiltration/command-substitution-url',
    description: 'Command substitution in URL (shell-based exfiltration)',
    pattern: /(?:curl|wget|fetch|http)\s+.*\$\(/i,
    severity: 'error',
  },
  {
    id: 'exfiltration/backtick-substitution-url',
    description: 'Backtick command substitution in URL',
    pattern: /(?:curl|wget|fetch|http)\s+.*`[^`]+`/i,
    severity: 'error',
  },
  {
    id: 'exfiltration/url-data-concat',
    description: 'Dynamic data concatenation in URL parameter',
    pattern: /(?:fetch|request|axios|http\.get)\s*\(\s*["'][^"']*\?\w+=["']\s*\+/i,
    severity: 'warning',
  },
  {
    id: 'exfiltration/env-var-transmission',
    description: 'Environment variable sent to external endpoint',
    pattern: /(?:send|post|transmit|upload|exfil)\s+.*\$(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i,
    severity: 'error',
  },
  {
    id: 'exfiltration/pipe-to-curl',
    description: 'Piping sensitive data to curl',
    pattern: /\|\s*(?:curl|wget)\s+/i,
    severity: 'warning',
  },
  {
    id: 'exfiltration/base64-encode-send',
    description: 'Base64 encoding before sending (obfuscation)',
    pattern: /base64\s+.*(?:curl|wget|fetch|send|post)/i,
    severity: 'warning',
  },
  // --- Multi-line patterns ---
  {
    id: 'exfiltration/fetch-url-concat-multiline',
    description: 'Multi-line: fetch/request with dynamic URL parameter concatenation across lines',
    pattern: /(?:fetch|request|axios|http\.get)\s*\(\s*["'][^"']*\?\w+=["']\s*\+/i,
    severity: 'warning',
    multiline: true,
  },
  {
    id: 'exfiltration/command-substitution-multiline',
    description: 'Multi-line: curl/wget with command substitution split across lines',
    pattern: /(?:curl|wget|fetch|http)\s+.*\$\(/i,
    severity: 'error',
    multiline: true,
  },
];
