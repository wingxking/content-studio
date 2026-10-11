import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveAssetPath, assetStore } from './assets.ts';
import { localfsDirectory } from './localfs.ts';
import { dataDirectory } from './store.ts';

export async function resolveMediaLocation(input: string): Promise<string> {
  if (input.startsWith('studio-asset:')) return resolveAssetPath(z.uuid().parse(input.slice('studio-asset:'.length)));
  const alias = await assetStore().resolveAlias(input); if (alias) return alias;
  const original = resolve(input);
  let relocation: string;
  try { relocation = await readFile(join(dataDirectory(), 'relocation.json'), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return original; throw error; }
  const mapping = z.object({ originalDataRoot: z.string() }).parse(JSON.parse(relocation));
  for (const directory of ['media', 'videos', 'renderers', 'content']) {
    const oldRoot = resolve(mapping.originalDataRoot, directory); const localRoot = resolve(dataDirectory(), directory);
    const suffix = relative(oldRoot, original);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) continue;
    const relocated = await realpath(join(localRoot, suffix)); const root = await realpath(localRoot);
    if (!relocated.startsWith(`${root}${sep}`)) throw new Error('Restored media escapes its isolated directory.'); return relocated;
  }
  return original;
}
export async function isManagedMediaPath(path: string): Promise<boolean> {
  const actual = await realpath(path);
  if (!/\.(png|jpe?g|webp|mp4|wav|mp3|srt|vtt)$/i.test(actual)) return false;
  for (const directory of [join(dataDirectory(), 'media'), join(dataDirectory(), 'videos'), join(dataDirectory(), 'renderers'), join(dataDirectory(), 'content'), join(localfsDirectory(), 'objects')]) {
    const root = await realpath(directory).catch(() => null); if (root && actual.startsWith(`${root}${sep}`)) return true;
  }
  return false;
}
