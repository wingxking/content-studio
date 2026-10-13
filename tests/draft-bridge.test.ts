import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { WebSocket } from 'ws';
import { createDraftBridge } from '../src/server/draft-bridge.ts';
import { draftBridgeConfigStatus, readDraftBridgeConfig, saveDraftBridgeConfig, type DraftBridgeConfig } from '../src/core/draft-bridge-config.ts';

const fixture: DraftBridgeConfig = { extensionId: 'a'.repeat(32), extensionToken: 'private-extension-token-fixture', pairingKey: 'pairing-key-fixture-'.repeat(3), serviceKey: 'service-key-fixture-'.repeat(3) };
let directory: string; let configPath: string;
let bridge: ReturnType<typeof createDraftBridge>; let address: { wsPort: number; httpPort: number };
const clients: WebSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-draft-bridge-')); configPath = join(directory, 'private', 'config.json');
  await saveDraftBridgeConfig(fixture, configPath);
  bridge = createDraftBridge({ configPath, host: '127.0.0.1', wsPort: 0, httpPort: 0, readTimeoutMs: 250, writeTimeoutMs: 250 }); address = await bridge.start();
});
afterEach(async () => { for (const client of clients.splice(0)) client.terminate(); await bridge.close(); await rm(directory, { recursive: true, force: true }); });

async function connect(options: { origin?: string; key?: string } = {}): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${address.wsPort}/connect?key=${options.key ?? fixture.pairingKey}`, { headers: { Origin: options.origin ?? `chrome-extension://${fixture.extensionId}` } }); clients.push(client);
  return new Promise((resolve, reject) => { client.once('open', () => resolve(client)); client.once('error', reject); });
}
const headers = () => ({ Authorization: `Bearer ${fixture.serviceKey}`, 'Content-Type': 'application/json' });
async function request(value: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`http://127.0.0.1:${address.httpPort}/request`, { method: 'POST', headers: { ...headers(), ...extra }, body: JSON.stringify(value) });
  return { status: response.status, data: await response.json() };
}
type Message = { id: string; method: string; token: string; params: Record<string, unknown> };
function nextMessage(client: WebSocket): Promise<Message> { return new Promise(resolve => client.once('message', bytes => resolve(JSON.parse(bytes.toString()) as Message))); }
const sync = (platform = 'zhihu') => ({ method: 'syncArticle', params: { platforms: [platform], article: { title: 'Reviewed title', content: '<p>Reviewed original article</p>' } } });

test('bridge config is private, atomic, strict and never reveals tokens through status or errors', async () => {
  assert.deepEqual(await readDraftBridgeConfig(configPath), fixture);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await draftBridgeConfigStatus(configPath), { configured: true, extensionId: fixture.extensionId });
  assert.equal(await readDraftBridgeConfig(join(directory, 'absent.json')), null);
  await assert.rejects(saveDraftBridgeConfig({ ...fixture, extensionId: 'bad-secret-extension-id' }, configPath), /configuration is invalid/);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')) as unknown, fixture);
  await writeFile(configPath, '{"secret":"do-not-expose"}');
  await assert.rejects(readDraftBridgeConfig(configPath), error => error instanceof Error && error.message === 'Draft bridge configuration is invalid.');
});

test('HTTP requires internal bearer authorization and rejects browser origins', async () => {
  const unauthenticated = await fetch(`http://127.0.0.1:${address.httpPort}/status`);
  assert.equal(unauthenticated.status, 401);
  const browser = await request({ method: 'listPlatforms' }, { Origin: 'http://localhost:14310' }); assert.equal(browser.status, 403);
  const status = await fetch(`http://127.0.0.1:${address.httpPort}/status`, { headers: headers() });
  assert.deepEqual(await status.json(), { configured: true, connected: false });
  assert.equal(status.headers.get('access-control-allow-origin'), null);
});

test('unpaired process remains healthy while draft operations stay unavailable', async () => {
  await rm(configPath);
  const health = await fetch(`http://127.0.0.1:${address.httpPort}/healthz`);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
  assert.equal((await request(sync())).status, 503);
  await assert.rejects(connect(), /503/);
});

test('WebSocket requires both the exact extension origin and pairing key and cannot take over a live session', async () => {
  await assert.rejects(connect({ origin: 'https://evil.example' }), /403/);
  await assert.rejects(connect({ key: 'wrong-key' }), /403/);
  const client = await connect();
  await assert.rejects(connect(), /409/);
  const message = nextMessage(client); const result = request({ method: 'checkAuth', params: { platform: 'zhihu' } });
  const payload = await message; assert.equal(payload.token, fixture.extensionToken);
  client.send(JSON.stringify({ id: payload.id, result: { isAuthenticated: true, userId: 'target-id' } }));
  assert.deepEqual(await result, { status: 200, data: { result: { isAuthenticated: true, userId: 'target-id' } } });
});

test('only reviewed one-target draft methods are forwarded without a publish option', async () => {
  const client = await connect();
  for (const platform of ['weixin', 'zhihu', 'bilibili']) {
    const message = nextMessage(client); const result = request(sync(platform)); const payload = await message;
    assert.equal(payload.method, 'syncArticle'); assert.deepEqual(payload.params, sync(platform).params);
    assert.equal(Object.hasOwn(payload.params, 'draftOnly'), false);
    client.send(JSON.stringify({ id: payload.id, result: { results: [{ platform, success: true, postId: '123', draftOnly: true }], syncId: 'sync-1' } }));
    assert.equal((await result).status, 200);
  }
  for (const value of [
    { method: 'extractArticle' }, { method: 'publish' }, sync('xiaohongshu'),
    { ...sync(), params: { ...sync().params, platforms: ['zhihu', 'bilibili'] } },
    { ...sync(), params: { ...sync().params, draftOnly: false } },
    { ...sync(), params: { ...sync().params, article: { ...sync().params.article, publish: true } } },
    { method: 'uploadImage', params: { platform: 'weibo', mimeType: 'image/png', imageData: 'YQ==' } },
  ]) assert.equal((await request(value)).status, 400);
});

test('image upload uses one reviewed target and bounded base64 without exposing filesystem paths', async () => {
  const client = await connect(); const message = nextMessage(client);
  const result = request({ method: 'uploadImage', params: { platform: 'bilibili', mimeType: 'image/png', imageData: 'YQ==' } });
  const payload = await message; assert.equal(payload.method, 'uploadImage');
  client.send(JSON.stringify({ id: payload.id, result: { platform: 'bilibili', url: 'https://i0.hdslb.com/example.png' } })); assert.equal((await result).status, 200);
  assert.equal((await request({ method: 'uploadImage', params: { platform: 'bilibili', mimeType: 'image/png', imageData: '/data/media.png' } })).status, 400);
});

test('write disconnect is unknown and concurrent work cannot pass an active request', async () => {
  const client = await connect(); const message = nextMessage(client); const result = request(sync()); await message;
  assert.deepEqual(await request({ method: 'listPlatforms' }), { status: 409, data: { error: { code: 'BUSY', message: 'A browser companion request is already running.' } } });
  client.terminate();
  const stopped = await result; assert.equal(stopped.status, 502); assert.equal((stopped.data as { error: { code: string } }).error.code, 'UNKNOWN_OUTCOME');
});

test('a timed-out write is unknown and its late response cannot complete another request', async () => {
  const client = await connect(); const message = nextMessage(client); const result = request(sync()); const old = await message;
  const timeout = await result; assert.equal(timeout.status, 504); assert.equal((timeout.data as { error: { code: string } }).error.code, 'UNKNOWN_OUTCOME');
  const next = nextMessage(client); const read = request({ method: 'checkAuth', params: { platform: 'zhihu' } }); const current = await next;
  client.send(JSON.stringify({ id: old.id, result: { secret: 'old response' } }));
  client.send(JSON.stringify({ id: current.id, result: { isAuthenticated: false } }));
  assert.deepEqual(await read, { status: 200, data: { result: { isAuthenticated: false } } });
});

test('extension errors and malformed replies never echo platform secrets', async () => {
  const client = await connect(); const message = nextMessage(client); const result = request(sync()); const payload = await message;
  client.send(JSON.stringify({ id: payload.id, error: { code: -1, message: 'https://platform.example/?token=private-session' } }));
  const failed = await result; assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed.data).includes('private-session'));
  const next = nextMessage(client); const invalid = request(sync()); await next; client.send('not json secret');
  assert.equal(((await invalid).data as { error: { code: string } }).error.code, 'EXTENSION_RESPONSE_INVALID');
});

test('config rotation invalidates the old browser session before further dispatch', async () => {
  await connect(); await saveDraftBridgeConfig({ ...fixture, extensionToken: 'a-different-private-extension-token' }, configPath);
  assert.equal((await request({ method: 'checkAuth', params: { platform: 'zhihu' } })).status, 503);
  const status = await fetch(`http://127.0.0.1:${address.httpPort}/status`, { headers: headers() });
  assert.deepEqual(await status.json(), { configured: true, connected: false });
});
