import { readFile } from 'node:fs/promises';
import { runtimeReleaseSchema, type RuntimeRelease } from '../contracts/runtime-release.ts';

/** Read the immutable image's manifest, never host environment or private config. */
export async function readRuntimeRelease(path: string | URL = new URL('../../release.json', import.meta.url)): Promise<RuntimeRelease | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 4096) return null;
    const parsed = runtimeReleaseSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
