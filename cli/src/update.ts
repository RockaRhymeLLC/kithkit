/**
 * kithkit update — update installed skills.
 * Wraps @kithkit/client's lifecycle functions via dynamic import.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface UpdateCommandOptions {
  skillName?: string;
  projectDir?: string;
  catalogUrl?: string;
}

export interface UpdateCommandResult {
  updatesAvailable: number;
  updated: string[];
}

function clientPath(module: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..', 'packages', 'kithkit-client', 'src', module);
}

/**
 * Check for and apply updates to installed skills.
 */
export async function runUpdate(opts: UpdateCommandOptions): Promise<UpdateCommandResult> {
  const projectDir = opts.projectDir ?? process.cwd();
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  const cacheDir = path.join(projectDir, '.kithkit', 'cache');
  const catalogUrl = opts.catalogUrl ?? 'https://catalog.kithkit.com/index.json';

  const searchMod = await import(clientPath('search.ts'));
  const lifecycleMod = await import(clientPath('lifecycle.ts'));

  const cache = new searchMod.CatalogCache(cacheDir);
  const index = await cache.getOrFetch(async () => {
    const res = await fetch(catalogUrl);
    if (!res.ok) throw new Error(`Failed to fetch catalog: ${res.status}`);
    return res.json();
  });

  const updated: string[] = [];

  if (opts.skillName) {
    const result = await lifecycleMod.updateSkill({
      skillName: opts.skillName,
      skillsDir,
      index,
    });
    if (result.success) {
      console.log(`Updated ${opts.skillName} to v${result.version}`);
      updated.push(opts.skillName);
    } else {
      console.log(`${opts.skillName}: ${result.error ?? 'no update available'}`);
    }
    return { updatesAvailable: result.success ? 1 : 0, updated };
  }

  const results = await lifecycleMod.checkAllUpdates(skillsDir, index);
  const withUpdates = results.filter((r: { hasUpdate: boolean }) => r.hasUpdate);

  if (withUpdates.length === 0) {
    console.log('All skills are up to date.');
  } else {
    console.log(`${withUpdates.length} update(s) available:`);
    for (const r of withUpdates) {
      console.log(`  ${r.skillName}: ${r.currentVersion} → ${r.latestVersion}`);
    }
  }

  return { updatesAvailable: withUpdates.length, updated };
}
