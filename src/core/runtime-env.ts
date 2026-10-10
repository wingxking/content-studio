import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadRuntimeEnvironment(): Promise<void> {
  const file = resolve(process.env.STUDIO_DATA_DIR ?? '.studio', 'runtime.env');
  let content: string;
  try { content = await readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error('Could not read the private local runtime configuration.');
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new Error('Invalid local runtime configuration.');
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value: unknown;
    try { value = JSON.parse(match[2]) as unknown; }
    catch { throw new Error('Invalid local runtime configuration value.'); }
    if (typeof value !== 'string') throw new Error('Invalid local runtime configuration value type.');
    process.env[key] = value;
  }
}
