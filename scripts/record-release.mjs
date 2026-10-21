import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hash only repository-owned application code and prompt policy, never runtime data. */
export async function createReleaseManifest(root, version, builtAt = new Date().toISOString()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(version ?? '') || version === 'latest') throw new Error('Provide a fixed release identifier.');
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error('Provide a valid build time.');
  const files = [];
  async function visit(relative) {
    if (!(await lstat(join(root, relative))).isDirectory()) throw new Error('Release source must be a regular directory.');
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Release source must not contain symbolic links.');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const relative of ['src', 'scripts', 'public', 'supabase/migrations', '.agents/skills']) await visit(relative);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (/^(?:package(?:-lock)?\.json|tsconfig(?:\.[a-z]+)?\.json|vite\.config\.ts|index\.html)$/u.test(entry.name)) {
      if (!entry.isFile()) throw new Error('Release configuration must be a regular file.');
      files.push(entry.name);
    }
  }
  files.sort();
  const manifest = [];
  for (const path of files) manifest.push([path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]);
  return { version, builtAt: new Date(builtAt).toISOString(), sourceDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await createReleaseManifest(process.cwd(), process.env.STUDIO_RELEASE ?? 'local');
  await writeFile('release.json', `${JSON.stringify(release, null, 2)}\n`, { mode: 0o444 });
  console.log(`Recorded immutable application release ${release.version}.`);
}
