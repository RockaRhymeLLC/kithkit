/**
 * Prompt Injection Patterns
 *
 * Data-driven pattern definitions. Add new patterns here without code changes.
 * Informed by Cisco AI Skill Scanner YARA rules and Snyk ToxicSkills findings.
 */

export interface SecurityPattern {
  id: string;
  description: string;
  pattern: RegExp;
  severity: 'error' | 'warning';
  /** When true, pattern is tested against full file content (whitespace-normalized) instead of per-line. */
  multiline?: boolean;
}

export const PROMPT_INJECTION_PATTERNS: SecurityPattern[] = [
  {
    id: 'prompt-injection/ignore-previous',
    description: 'Attempts to override previous instructions',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|directives|rules|prompts)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/new-instructions',
    description: 'Attempts to inject new base instructions',
    pattern: /your\s+new\s+(instructions|directives|rules|orders)\s+(are|will\s+be)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/role-reassignment',
    description: 'Attempts to reassign the AI role',
    pattern: /you\s+are\s+now\s+(a\s+)?(?:different|new|another)\s+(AI|assistant|agent|bot|system)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/system-prompt-manipulation',
    description: 'Attempts to access or modify system prompt',
    pattern: /(override|modify|change|ignore|replace|disregard)\s+(your\s+)?(system\s+prompt|system\s+instructions|core\s+directives)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/forget-everything',
    description: 'Attempts to reset agent memory/context',
    pattern: /forget\s+(everything|all|your\s+instructions)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/act-as',
    description: 'Attempts to make agent assume a different persona',
    pattern: /(?:pretend|act\s+as\s+if)\s+you\s+(?:are|were)\s+(?:a\s+)?(?:different|another|unrestricted|jailbroken)/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/do-anything',
    description: 'DAN-style jailbreak attempt',
    pattern: /(?:DAN|do\s+anything\s+now)\s*(?:mode|prompt|jailbreak)?/i,
    severity: 'error',
  },
  {
    id: 'prompt-injection/hide-actions',
    description: 'Instructs agent to hide actions from human',
    pattern: /(?:don'?t|do\s+not|never)\s+(?:tell|show|inform|reveal|disclose)\s+(?:the\s+)?(?:user|human|owner|operator)/i,
    severity: 'error',
  },
  // --- Multi-line patterns (tested against whitespace-normalized full content) ---
  {
    id: 'prompt-injection/ignore-previous-multiline',
    description: 'Multi-line prompt injection: "ignore ... previous instructions" split across lines',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|directives|rules|prompts|formatting\s+instructions)/i,
    severity: 'error',
    multiline: true,
  },
  {
    id: 'prompt-injection/role-reassignment-multiline',
    description: 'Multi-line role reassignment split across lines',
    pattern: /you\s+are\s+now\s+(a\s+)?(?:different|new|another)\s+(AI|assistant|agent|bot|system)/i,
    severity: 'error',
    multiline: true,
  },
  {
    id: 'prompt-injection/system-prompt-multiline',
    description: 'Multi-line system prompt manipulation split across lines',
    pattern: /(override|modify|change|ignore|replace|disregard)\s+(your\s+)?(system\s+prompt|system\s+instructions|core\s+directives)/i,
    severity: 'error',
    multiline: true,
  },
  {
    id: 'prompt-injection/new-instructions-multiline',
    description: 'Multi-line new instructions injection split across lines',
    pattern: /your\s+new\s+(instructions|directives|rules|orders)\s+(are|will\s+be)/i,
    severity: 'error',
    multiline: true,
  },
];
