import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from './store.ts';
import { writePrivateJson } from './youtube-oauth.ts';
import type { Job } from './model.ts';

const publicRoot = (): string => join(dataDirectory(), 'publication-journals');
export async function markYouTubeJournalPresence(jobId: string): Promise<void> {
  const id = z.uuid().parse(jobId); await writePrivateJson(join(publicRoot(), `${id}.json`), { jobId: id, journalPresent: true });
}
export async function initializeJournalPresence(): Promise<void> {
  await mkdir(publicRoot(), { recursive: true, mode: 0o700 });
  let names: string[];
  try { names = await readdir(join(dataDirectory(), 'youtube', 'uploads')); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; names = []; }
  for (const name of names) if (name.endsWith('.json') && z.uuid().safeParse(name.slice(0, -5)).success) await markYouTubeJournalPresence(name.slice(0, -5));
  await writePrivateJson(join(publicRoot(), 'ready.json'), { ready: true });
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
export async function hasYouTubeUploadJournal(job: Pick<Job, 'id' | 'platform' | 'provider'>): Promise<boolean> {
  if (job.platform !== 'youtube' || job.provider !== 'native') return false;
  if (await exists(join(publicRoot(), `${z.uuid().parse(job.id)}.json`))) return true;
  if (process.env.STUDIO_CONTAINER === 'true' && process.env.STUDIO_WORKER_ROLE !== 'delivery' && !await exists(join(publicRoot(), 'ready.json'))) throw new Error('Delivery journal safety catalog is not ready. Start the delivery worker before changing publication state.');
  return exists(resolve(dataDirectory(), 'youtube', 'uploads', `${job.id}.json`));
}
