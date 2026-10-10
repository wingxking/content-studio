import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { dataDirectory } from './store.ts';

export async function resolveMediaLocation(input: string): Promise<string> {
  const original = resolve(input);
  let relocation: string;
  try { relocation = await readFile(join(dataDirectory(), 'relocation.json'), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return original; throw error; }
  const mapping = z.object({ originalDataRoot: z.string() }).parse(JSON.parse(relocation));
  const oldMedia = resolve(mapping.originalDataRoot, 'media');
  const localMedia = resolve(dataDirectory(), 'media');
  const suffix = relative(oldMedia, original);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) return original;
  const relocated = await realpath(join(localMedia, suffix));
  const root = await realpath(localMedia);
  if (!relocated.startsWith(`${root}${sep}`)) throw new Error('Restored media escapes its isolated directory.');
  return relocated;
}
