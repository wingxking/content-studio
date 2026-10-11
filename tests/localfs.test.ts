import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import { LocalAssetStore, type LocalAssetRecord } from '../src/core/localfs.ts';
import { createUploadRouter } from '../src/server/uploads.ts';

let directory = ''; const workspace = randomUUID(); const servers: HttpServer[] = [];
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(512, 42)]);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'studio-localfs-')); });
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); });
async function listen(store: LocalAssetStore, options: { ttlMs?: number; intakeCapacityBytes?: number } = {}): Promise<string> {
  const app = express(); app.use(await createUploadRouter({ store, workspaceId: workspace, ...options }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => { response.status(400).json({ error: error instanceof Error ? error.message : 'Upload failed.' }); });
  const server = createServer(app); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}
test('streaming ingestion hashes real bytes and physically deduplicates immutable objects', async () => {
  const rows = new Map<string, LocalAssetRecord>(); const store = new LocalAssetStore(async record => { rows.set(record.id, record); }, directory);
  const first = await store.ingest('one.png', Readable.from([png.subarray(0, 20), png.subarray(20)]), workspace);
  const second = await store.ingest('two.png', Readable.from([png]), workspace);
  assert.notEqual(first.id, second.id); assert.equal(first.object_key, second.object_key); assert.equal(first.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(rows.size, 2); assert.equal(first.status, 'finalized'); assert.deepEqual(await readFile(await store.verify(first)), png);
});
test('restart repairs a promoted object when registry finalization failed and finalize is idempotent', async () => {
  const rows = new Map<string, LocalAssetRecord>(); let fail = true;
  const registry = async (record: LocalAssetRecord) => { if (record.status === 'finalized' && fail) throw new Error('Database offline'); rows.set(record.id, record); };
  const store = new LocalAssetStore(registry, directory);
  await assert.rejects(store.ingest('recovery.png', Readable.from([png]), workspace), /Database offline/);
  const pending = [...rows.values()][0]; assert(pending); assert.equal(pending.status, 'pending'); assert.deepEqual(await readFile(await store.verify(pending)), png);
  fail = false; const restarted = new LocalAssetStore(registry, directory); assert.deepEqual(await restarted.repair(), { repaired: 1, failures: [] });
  const complete = await restarted.finalize(pending.upload_id, 'ignored.png', workspace); assert.equal(complete.id, pending.id); assert.equal(rows.size, 1);
});
test('invalid signature and oversized image never become selectable assets', async () => {
  const rows: LocalAssetRecord[] = []; const store = new LocalAssetStore(async record => { rows.push(record); }, directory);
  await assert.rejects(store.ingest('fake.png', Readable.from(['not media']), workspace), /Unsupported file contents/);
  async function* oversized() { yield png; for (let i = 0; i < 25; i++) yield Buffer.alloc(1024 * 1024); }
  await assert.rejects(store.ingest('large.png', Readable.from(oversized()), workspace), /24 MiB/); assert.equal(rows.length, 0);
});
test('legacy literal aliases preserve their string identity and reject corrupted object bytes', async () => {
  const store = new LocalAssetStore(async () => {}, directory); const record = await store.ingest('legacy.png', Readable.from([png]), workspace);
  const literal = '/original/mac/path/revision-7/approved.png'; await store.alias(literal, record);
  assert.equal(await store.resolveAlias(literal), await store.verify(record)); assert.equal(await store.resolveAlias('/different/path/approved.png'), null);
  await writeFile(await store.verify(record), Buffer.concat([png.subarray(0, 8), Buffer.alloc(512)]));
  await assert.rejects(store.resolveAlias(literal), /integrity/);
});
test('tus survives API restart mid-upload and returns one finalized asset after duplicate finish checks', async () => {
  const rows = new Map<string, LocalAssetRecord>(); const registry = async (record: LocalAssetRecord) => { rows.set(record.id, record); };
  let base = await listen(new LocalAssetStore(registry, directory));
  const created = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(png.length), 'Upload-Metadata': `filename ${Buffer.from('resume.png').toString('base64')}` } });
  assert.equal(created.status, 201); const location = created.headers.get('location'); assert(location);
  const patch = (bytes: Buffer, offset: number) => fetch(`${base}${location}`, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: new Uint8Array(bytes) });
  assert.equal((await patch(png.subarray(0, 100), 0)).status, 204); assert.equal(rows.size, 0);
  const server = servers.pop(); assert(server); await new Promise<void>(resolve => server.close(() => resolve()));
  base = await listen(new LocalAssetStore(registry, directory));
  const head = await fetch(`${base}${location}`, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }); assert.equal(head.headers.get('upload-offset'), '100');
  const finished = await patch(png.subarray(100), 100); assert.equal(finished.status, 204); assert(finished.headers.get('x-asset-id'));
  const receipt = await fetch(`${base}${location}/asset`); assert.equal(receipt.status, 200); assert.equal(rows.size, 1);
  const record = [...rows.values()][0]; assert(record); assert.equal(record.status, 'finalized');
  const object = await new LocalAssetStore(registry, directory).verify(record); const intake = join(directory, 'intake', record.upload_id);
  assert.equal((await stat(object)).ino, (await stat(intake)).ino);
  assert.equal((await fetch(`${base}${location}/asset`)).status, 200); assert.equal(rows.size, 1);
});

test('completed uploads release pending capacity and expired unfinished uploads sweep without restart', async () => {
  const store = new LocalAssetStore(async () => {}, directory); const base = await listen(store, { intakeCapacityBytes: png.length, ttlMs: 60000 });
  const create = () => fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(png.length), 'Upload-Metadata': `filename ${Buffer.from('quota.png').toString('base64')}` } });
  const first = await create(); assert.equal(first.status, 201); const location = first.headers.get('location'); assert(location);
  const complete = await fetch(`${base}${location}`, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: new Uint8Array(png) }); assert.equal(complete.status, 204);
  const receipt = await store.receipt(location.split('/').at(-1) ?? ''); assert(receipt); const object = await store.verify(receipt);
  const pending = await create(); assert.equal(pending.status, 201); assert.equal((await create()).status, 413);
  const pendingId = pending.headers.get('location')?.split('/').at(-1); assert(pendingId);
  const expired = new Date(Date.now() - 120000); await utimes(join(directory, 'intake', pendingId), expired, expired);
  assert.equal((await create()).status, 201);
  assert.deepEqual(await readFile(object), png); assert.equal((await fetch(`${base}${location}/asset`)).status, 200);
});
