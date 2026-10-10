import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiscoverySnapshot } from './discovery.ts';

export async function saveDiscoverySnapshot(snapshot: DiscoverySnapshot): Promise<string> {
  const directory = resolve(process.env.STUDIO_DATA_DIR ?? '.studio', 'discovery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}
