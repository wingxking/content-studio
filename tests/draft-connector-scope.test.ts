import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { bindDraftAccount, draftConnectorStatus, verifyDraftAccount, type nativeDraftPlatformSchema } from '../src/core/draft-connectors.ts';
import { saveDraftBridgeConfig } from '../src/core/draft-bridge-config.ts';
import { draftConnectorApi } from '../src/server/draft-api.ts';
import { readState } from '../src/core/store.ts';

const environment = { ...process.env }; const originalFetch = globalThis.fetch; let directory = '';
let authPlatforms: string[] = []; let bridgeReads = 0;
let authReply: unknown;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'draft-connector-scope-'));
  process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(directory, 'fixture-config.json');
  process.env.STUDIO_DRAFT_BRIDGE_URL = 'http://draft-bridge:8915';
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
  await saveDraftBridgeConfig({ extensionId: 'a'.repeat(32), extensionToken: 'scope-fixture-token', pairingKey: 'fixture-pairing-'.repeat(4), serviceKey: 'fixture-service-'.repeat(4) });
  authPlatforms = []; bridgeReads = 0; authReply = undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'http://draft-bridge:8915/status') { bridgeReads++; return Response.json({ connected: true }); }
    assert.equal(url, 'http://draft-bridge:8915/request');
    const request = z.object({ method: z.literal('checkAuth'), params: z.object({ platform: z.string() }).strict() }).strict().parse(JSON.parse(String(init?.body)));
    authPlatforms.push(request.params.platform);
    return Response.json({ result: authReply ?? { isAuthenticated: true, userId: `fixture-${request.params.platform}`, username: 'Fixture account' } });
  };
});
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...environment }; await rm(directory, { recursive: true, force: true }); });

test('selected connector status probes exactly one requested adapter', async () => {
  for (const [platform, adapter] of [['zhihu', 'zhihu'], ['wechat', 'weixin'], ['bilibili', 'bilibili']] as const) {
    authPlatforms = [];
    const result = await draftConnectorStatus(platform);
    assert.deepEqual(authPlatforms, [adapter]); assert.deepEqual(result.accounts.map(account => account.platform), [platform]);
  }
});
test('legacy connector status without a platform preserves its three-platform behavior', async () => {
  const result = await draftConnectorStatus();
  assert.deepEqual(authPlatforms, ['weixin', 'zhihu', 'bilibili']);
  assert.deepEqual(result.accounts.map(account => account.platform), ['wechat', 'zhihu', 'bilibili']);
});
test('unsupported core scope rejects before contacting the companion', async () => {
  await assert.rejects(draftConnectorStatus('weixin' as z.infer<typeof nativeDraftPlatformSchema>));
  assert.deepEqual(authPlatforms, []); assert.equal(bridgeReads, 0);
});
test('binding a Zhihu account checks only Zhihu identity', async () => {
  const account = await bindDraftAccount('zhihu', { expectedUserId: 'fixture-zhihu', permissionConfirmed: true });
  assert.deepEqual(authPlatforms, ['zhihu']); assert.equal(bridgeReads, 0);
  assert.equal(account.platform, 'zhihu'); assert.equal(account.draftConnection?.userId, 'fixture-zhihu');
});

test('upstream authentication timeout is unavailable, hides cached identity and cannot bind', async () => {
  authReply = { isAuthenticated: false, userId: 'cached-id', username: 'Cached name', error: '认证检查超时（10秒）' };
  const status = await draftConnectorStatus('zhihu');
  assert.equal(status.accounts[0]?.errorCode, 'timeout'); assert.match(status.accounts[0]?.error ?? '', /超时/u);
  assert.equal(status.accounts[0]?.isAuthenticated, false); assert.equal(status.accounts[0]?.userId, undefined); assert.equal(status.accounts[0]?.username, undefined);
  await assert.rejects(bindDraftAccount('zhihu', { expectedUserId: 'cached-id', permissionConfirmed: true }), /核对超时/u);
  assert.equal((await readState()).accounts.length, 0); assert.deepEqual(authPlatforms, ['zhihu', 'zhihu']);
});

test('upstream auth errors never disclose URLs or secrets, even with an authenticated cached identity', async () => {
  const bound = await bindDraftAccount('zhihu', { expectedUserId: 'fixture-zhihu', permissionConfirmed: true });
  authReply = { isAuthenticated: true, userId: 'fixture-zhihu', username: 'Cached name', error: 'Failed fetching https://private.example/profile?token=TOP_SECRET_COOKIE using Bearer PRIVATE_TOKEN' };
  const status = await draftConnectorStatus('zhihu'); const identity = status.accounts[0];
  assert.equal(identity?.errorCode, 'check_failed'); assert.equal(identity?.isAuthenticated, false); assert.equal(identity?.userId, undefined); assert.equal(identity?.username, undefined);
  assert.doesNotMatch(JSON.stringify(identity), /private\.example|TOP_SECRET|PRIVATE_TOKEN|Cached name|Bearer/u);
  for (const operation of [() => bindDraftAccount('zhihu', { expectedUserId: 'fixture-zhihu', permissionConfirmed: true }), () => verifyDraftAccount(bound)]) {
    await assert.rejects(operation, error => error instanceof Error && /核对暂不可用/u.test(error.message) && !/https:|TOP_SECRET|PRIVATE_TOKEN|Bearer/u.test(error.message));
  }
  assert.equal((await readState()).accounts.length, 1);
});

test('a normal unauthenticated reply remains a login result without a fabricated check error', async () => {
  authReply = { isAuthenticated: false };
  const status = await draftConnectorStatus('zhihu');
  assert.deepEqual(status.accounts, [{ platform: 'zhihu', isAuthenticated: false }]);
  await assert.rejects(bindDraftAccount('zhihu', { expectedUserId: 'expected-id', permissionConfirmed: true }), /signed-in platform identity changed/u);
  assert.equal((await readState()).accounts.length, 0);
});

test('HTTP platform query is strict, single-valued and cannot fall back to checking every adapter', async () => {
  const app = express(); app.use('/api', draftConnectorApi);
  const fail: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).json({ error: 'Invalid connector request.' }); }; app.use(fail);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (query: string): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: address.port, path: `/api/publishing/draft-connectors${query}` }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += String(chunk); });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as unknown }));
    }).once('error', reject);
  });
  try {
    const selected = await request('?platform=zhihu'); assert.equal(selected.status, 200); assert.deepEqual(authPlatforms, ['zhihu']);
    const result = z.object({ accounts: z.array(z.object({ platform: z.string() })) }).parse(selected.body); assert.deepEqual(result.accounts.map(account => account.platform), ['zhihu']);
    for (const query of ['?platform=weixin', '?platform=', '?platform=zhihu&platform=wechat', '?platform%5B0%5D=zhihu', '?platform=zhihu&all=true']) {
      authPlatforms = []; bridgeReads = 0; assert.equal((await request(query)).status, 400); assert.deepEqual(authPlatforms, []); assert.equal(bridgeReads, 0);
    }
    authPlatforms = []; assert.equal((await request('')).status, 200); assert.deepEqual(authPlatforms, ['weixin', 'zhihu', 'bilibili']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
