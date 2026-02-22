/**
 * kithkit search — search the skill catalog.
 * Wraps @kithkit/client's searchCatalog() via dynamic import.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SearchCommandOptions {
  query: string;
  tag?: string;
  capability?: string;
  catalogUrl?: string;
  cacheDir?: string;
}

function clientPath(module: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..', 'packages', 'kithkit-client', 'src', module);
}

/**
 * Search the skill catalog and print results.
 */
export async function runSearch(opts: SearchCommandOptions): Promise<string> {
  const cacheDir = opts.cacheDir ?? path.join(process.cwd(), '.kithkit', 'cache');
  const catalogUrl = opts.catalogUrl ?? 'https://catalog.kithkit.com/index.json';

  const searchMod = await import(clientPath('search.ts'));
  const cache = new searchMod.CatalogCache(cacheDir);

  const index = await cache.getOrFetch(async () => {
    const res = await fetch(catalogUrl);
    if (!res.ok) throw new Error(`Failed to fetch catalog: ${res.status}`);
    return res.json();
  });

  const results = searchMod.searchCatalog(index, {
    text: opts.query,
    tag: opts.tag,
    capability: opts.capability,
  });

  const output = searchMod.formatSearchResults(results);
  console.log(output);
  return output;
}
