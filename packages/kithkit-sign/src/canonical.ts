export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
  }
  return sorted;
}
