import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataDirectory } from './store.ts';
import type { Job } from './model.ts';

export async function hasYouTubeUploadJournal(job: Pick<Job, 'id' | 'platform' | 'provider'>): Promise<boolean> {
  if (job.platform !== 'youtube' || job.provider !== 'native') return false;
  try { await stat(resolve(dataDirectory(), 'youtube', 'uploads', `${job.id}.json`)); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
