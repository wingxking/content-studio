import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { readState, dataDirectory } from '../src/core/store.ts';
import { listAssets, uploadAsset } from '../src/core/assets.ts';
import { recordRevision } from '../src/core/editor.ts';
await loadRuntimeEnvironment();
const state = await readState(); const root = await realpath(dataDirectory());
const known = new Set((await listAssets()).map(asset => asset.hash));
const paths = [...new Set([...state.drafts.flatMap(draft => draft.variants.flatMap(variant => variant.mediaPaths)), ...state.jobs.flatMap(job => job.snapshot?.variant.mediaPaths ?? [])])];
let imported = 0; let existing = 0; let unavailable = 0;
for (const path of paths) {
  const absolute = await realpath(path).catch(() => null);
  if (!absolute?.startsWith(`${root}${sep}`)) { unavailable++; continue; }
  const bytes = await readFile(absolute); const hash = createHash('sha256').update(bytes).digest('hex');
  if (known.has(hash)) { existing++; continue; }
  await uploadAsset(basename(path), bytes); known.add(hash); imported++;
}
for (const draft of state.drafts) await recordRevision(draft);
console.log(JSON.stringify({ imported, existing, unavailable, revisionsRecorded: state.drafts.length, sourceSnapshotsUnchanged: true }));
