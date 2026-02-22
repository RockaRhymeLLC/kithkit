/**
 * Kithkit Linter — Structure Checks
 *
 * Validates skill package directory structure:
 * - Required files present (manifest.yaml, SKILL.md)
 * - No executable files
 * - Size limits (individual files and total package)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { CheckResult, Finding } from '../types.ts';

// Executable file extensions that are not allowed in skill packages
const EXECUTABLE_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish',  // Shell scripts
  '.py', '.pyw',                     // Python
  '.js', '.mjs', '.cjs',            // JavaScript
  '.ts', '.mts', '.cts',            // TypeScript
  '.rb',                             // Ruby
  '.pl', '.pm',                      // Perl
  '.php',                            // PHP
  '.bin', '.exe', '.bat', '.cmd',    // Binary/Windows
  '.ps1', '.psm1',                   // PowerShell
  '.jar', '.class',                  // Java
  '.so', '.dylib', '.dll',          // Shared libraries
  '.wasm',                           // WebAssembly
]);

// Size limits
const MAX_FILE_SIZE = 1024 * 1024;       // 1 MB per file
const MAX_PACKAGE_SIZE = 5 * 1024 * 1024; // 5 MB total

const REQUIRED_FILES = ['manifest.yaml', 'SKILL.md'];

/**
 * Check the structure of a skill package directory.
 */
export function checkStructure(skillDir: string): CheckResult {
  const findings: Finding[] = [];

  if (!existsSync(skillDir)) {
    findings.push({
      severity: 'error',
      check: 'structure/exists',
      message: `Skill directory does not exist: ${skillDir}`,
    });
    return { pass: false, findings };
  }

  // Check required files
  for (const file of REQUIRED_FILES) {
    const filePath = join(skillDir, file);
    if (!existsSync(filePath)) {
      findings.push({
        severity: 'error',
        check: 'structure/required-files',
        message: `Missing required file: ${file}`,
        file,
      });
    }
  }

  // Walk all files in directory
  let totalSize = 0;
  const files = walkDir(skillDir);

  for (const relPath of files) {
    const fullPath = join(skillDir, relPath);
    const stat = statSync(fullPath);

    // Check for executable files
    const ext = extname(relPath).toLowerCase();
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      findings.push({
        severity: 'error',
        check: 'structure/no-executables',
        message: `Executable file detected (${ext}): ${relPath}`,
        file: relPath,
      });
    }

    // Check individual file size
    if (stat.size > MAX_FILE_SIZE) {
      findings.push({
        severity: 'error',
        check: 'structure/file-size',
        message: `File exceeds ${MAX_FILE_SIZE / 1024}KB limit: ${relPath} (${Math.round(stat.size / 1024)}KB)`,
        file: relPath,
      });
    }

    totalSize += stat.size;
  }

  // Check total package size
  if (totalSize > MAX_PACKAGE_SIZE) {
    findings.push({
      severity: 'error',
      check: 'structure/package-size',
      message: `Package exceeds ${MAX_PACKAGE_SIZE / (1024 * 1024)}MB limit: ${Math.round(totalSize / 1024)}KB total`,
    });
  }

  const hasErrors = findings.some(f => f.severity === 'error');
  return { pass: !hasErrors, findings };
}

/**
 * Recursively walk a directory, returning relative paths to all files.
 */
function walkDir(dir: string, prefix: string = ''): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...walkDir(join(dir, entry.name), relPath));
    } else {
      results.push(relPath);
    }
  }

  return results;
}
