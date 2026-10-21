import type { SourcePreference } from '../contracts/research.ts';
export { sourceCatalog } from '../contracts/sources.ts';

export function matchesSource(input: string, source: SourcePreference): boolean {
  const url = new URL(input); const root = new URL(source.url);
  if (url.hostname !== root.hostname && !url.hostname.endsWith(`.${root.hostname}`)) return false;
  if (source.scope === 'site') return true;
  if (source.scope === 'page') return url.pathname.replace(/\/$/u, '') === root.pathname.replace(/\/$/u, '') && url.search === root.search;
  const path = root.pathname.replace(/\/$/u, '');
  return url.pathname === path || url.pathname.startsWith(`${path}/`);
}

/** Largest-remainder allocation makes source preference measurable outside the model. */
export function discoveryAllocation(sources: SourcePreference[], budget: number): { preferred: { source: SourcePreference; slots: number }[]; open: number } {
  const active = sources.filter(source => source.enabled && !['disabled', 'requires_authorization'].includes(source.access));
  if (!active.length) return { preferred: [], open: budget };
  const reserved = Math.floor(budget * 0.7); const total = active.reduce((sum, item) => sum + item.weight, 0);
  const rows = active.map(source => ({ source, slots: Math.floor(reserved * source.weight / total), fraction: reserved * source.weight / total % 1 })).sort((a, b) => b.fraction - a.fraction || a.source.id.localeCompare(b.source.id));
  for (let i = 0, remaining = reserved - rows.reduce((sum, row) => sum + row.slots, 0); i < remaining; i++) rows[i % rows.length]!.slots++;
  return { preferred: rows.map(({ source, slots }) => ({ source, slots })), open: budget - reserved };
}

/** Apply quotas to application-owned page candidates, then transfer unused slots. */
export function allocateSourceCandidates<T extends { url: string; sourceId: string }>(candidates: T[], sources: SourcePreference[], budget: number): T[] {
  const allocation = discoveryAllocation(sources, budget); const selected = new Map<string, T>();
  const add = (items: T[], limit: number) => { for (const item of items) { if (limit <= 0 || selected.size >= budget) break; if (!selected.has(item.url)) { selected.set(item.url, item); limit--; } } };
  for (const { source, slots } of allocation.preferred) add(candidates.filter(item => item.sourceId === source.id), slots);
  const preferredIds = new Set(allocation.preferred.map(item => item.source.id));
  add(candidates.filter(item => !preferredIds.has(item.sourceId)), budget - selected.size);
  add([...candidates].sort((a, b) => (sources.find(item => item.id === b.sourceId)?.weight ?? 0) - (sources.find(item => item.id === a.sourceId)?.weight ?? 0)), budget - selected.size);
  return [...selected.values()];
}
