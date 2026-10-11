import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { readState } from '../src/core/store.ts';
import { assetStore, migrateStorageAssets, registerLegacyAlias } from '../src/core/assets.ts';
import { resolveMediaLocation } from '../src/core/media-location.ts';
import { dbRequest } from '../src/core/database.ts';
await loadRuntimeEnvironment();
const state = await readState();
const snapshots = await dbRequest(`studio_revisions?workspace_id=eq.${process.env.STUDIO_WORKSPACE_ID}&select=content`);
const videos = await dbRequest(`studio_video_projects?workspace_id=eq.${process.env.STUDIO_WORKSPACE_ID}&select=content`);
// Read all historical string media references without rewriting approvals, snapshots, jobs or upload journals.
function references(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(references);
  return Object.entries(value).flatMap(([key, entry]) => ['videoPath','audioPath','narrationPath','captionsPath','thumbnailPath'].includes(key) && typeof entry === 'string' ? [entry] : key === 'mediaPaths' && Array.isArray(entry) ? entry.filter((path): path is string => typeof path === 'string') : references(entry));
}
const paths = [...new Set([...references(state), ...references(snapshots), ...references(videos)])];
const storage = await migrateStorageAssets(); let imported = 0; let existing = 0; const unavailable: string[] = [];
for (const path of paths) {
  if (path.startsWith('studio-asset:')) { existing++; continue; }
  try {
    if (await assetStore().resolveAlias(path)) { existing++; continue; }
    await registerLegacyAlias(path, await resolveMediaLocation(path)); imported++;
  } catch { unavailable.push(path); }
}
console.log(JSON.stringify({ storage, imported, existing, unavailable, sourceSnapshotsUnchanged: true }));
