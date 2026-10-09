import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const base = process.env.STUDIO_TEST_URL ?? 'http://127.0.0.1:4310';
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'HTTP smoke tests must target the local studio.');
const dataRoot = resolve(process.env.STUDIO_DATA_DIR ?? '.studio');
const mediaRoot = join(dataRoot, 'media');
await mkdir(mediaRoot, { recursive: true });
const folder = await mkdtemp(join(mediaRoot, 'http-smoke-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEfcAAAAASUVORK5CYII=', 'base64');
try {
  const path = join(folder, 'card.png');
  await writeFile(path, png);
  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  const state: unknown = await status.json();
  assert.ok(typeof state === 'object' && state !== null && 'readiness' in state);
  const card = await fetch(`${base}/api/media?path=${encodeURIComponent(path)}`);
  assert.equal(card.status, 200, 'Generated media in the hidden .studio directory must be served.');
  assert.equal(card.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await card.arrayBuffer()), png);
  const origin = await fetch(`${base}/api/status`, { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(origin.status, 403);
  const outside = await fetch(`${base}/api/media?path=${encodeURIComponent(fileURLToPath(import.meta.url))}`);
  assert.equal(outside.status, 403, 'Files outside the media directory must not be served.');
  for (const name of ['research', 'accounts', 'architecture', 'acceptance']) {
    assert.equal((await fetch(`${base}/api/docs/${name}`)).status, 200);
  }
  assert.equal((await fetch(base)).status, 200);
  process.stdout.write('HTTP smoke passed: readiness, hidden-directory media bytes, origin restriction, media containment, four documents, and workbench response.\n');
} finally {
  await rm(folder, { recursive: true, force: true });
}
