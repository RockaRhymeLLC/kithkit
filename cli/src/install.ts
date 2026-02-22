/**
 * kithkit install — install a skill from the catalog.
 * Wraps @kithkit/client's installSkill() via dynamic import.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallCommandOptions {
  skillName: string;
  projectDir?: string;
}

export interface InstallCommandResult {
  success: boolean;
  version?: string;
  error?: string;
}

function clientPath(module: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..', 'packages', 'kithkit-client', 'src', module);
}

/**
 * Install a skill into .claude/skills/.
 */
export async function runInstall(opts: InstallCommandOptions): Promise<InstallCommandResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const skillsDir = path.join(projectDir, '.claude', 'skills');

  const mod = await import(clientPath('install.ts'));
  const result = await mod.installSkill({ skillName: opts.skillName, skillsDir });

  if (result.success) {
    console.log(`Installed ${opts.skillName} v${result.version} to .claude/skills/${opts.skillName}/`);
  } else {
    console.error(`Failed to install ${opts.skillName}: ${result.error}`);
  }

  return { success: result.success, version: result.version, error: result.error };
}
