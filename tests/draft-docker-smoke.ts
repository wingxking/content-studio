import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { z } from 'zod';

// Run explicitly inside the application container. Never reuse the configured workspace.
if (process.env.STUDIO_CONTAINER !== 'true' || !process.env.SUPABASE_URL) throw new Error('Run this smoke in the configured Docker API container.');
const workspaceId = randomUUID(); const directory = await mkdtemp(join(tmpdir(), 'draft-acceptance-'));
process.env.STUDIO_WORKSPACE_ID = workspaceId;
process.env.STUDIO_DATA_DIR = directory;
process.env.STUDIO_LOCALFS_DIR = join(directory, 'media/localfs');
process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(directory, 'bridge/config.json');
process.env.STUDIO_WORKER_ROLE = 'delivery';
const { createDraftBridge } = await import('../src/server/draft-bridge.ts');
const { draftConnectorApi } = await import('../src/server/draft-api.ts');
const { createDraft } = await import('../src/core/pipeline.ts');
const { mutateState, readState } = await import('../src/core/store.ts');
const { readDraftBridgeConfig } = await import('../src/core/draft-bridge-config.ts');
const { runWorkerOnce } = await import('../src/server/worker.ts');
const { listOperations } = await import('../src/core/editor.ts');
const bridge = createDraftBridge({ host: '127.0.0.1', wsPort: 0, httpPort: 0 });
const ports = await bridge.start();
process.env.STUDIO_DRAFT_BRIDGE_URL = `http://127.0.0.1:${ports.httpPort}`;
const app = express(); app.use(express.json()); app.use('/api', draftConnectorApi);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Smoke listener failed.');
const origin = `http://127.0.0.1:${address.port}/api`;
const post = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(`${origin}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); return response.json();
};
let socket: WebSocket | undefined; let writes = 0;
try {
  await mutateState(state => { state.paused = true; });
  await post('publishing/draft-connectors/bridge', { extensionId: 'a'.repeat(32), extensionToken: 'fixture-only-token-2026' });
  const config = await readDraftBridgeConfig(); assert.ok(config);
  socket = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/connect?key=${config.pairingKey}`, { origin: `chrome-extension://${config.extensionId}` });
  socket.on('message', raw => {
    const message = z.object({ id: z.string(), method: z.string(), token: z.string(), params: z.record(z.string(), z.unknown()) }).parse(JSON.parse(raw.toString()));
    assert.equal(message.token, config.extensionToken);
    let result: unknown;
    if (message.method === 'checkAuth') result = { isAuthenticated: true, userId: `fixture-${String(message.params.platform)}`, username: 'Isolated draft acceptance' };
    else {
      assert.equal(message.method, 'syncArticle'); writes++;
      const parameters = z.object({ platforms: z.tuple([z.enum(['weixin', 'zhihu', 'bilibili'])]), article: z.object({ title: z.string(), content: z.string() }) }).parse(message.params);
      assert.match(parameters.article.content, /https:\/\/www.w3.org/);
      const platform = parameters.platforms[0]; const id = String(1000 + writes);
      const postUrl = platform === 'weixin' ? `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=${id}&token=fixture-secret` : platform === 'zhihu' ? `https://zhuanlan.zhihu.com/p/${id}/edit` : `https://member.bilibili.com/platform/upload/text/edit?aid=${id}`;
      result = { results: [{ platform, success: true, draftOnly: true, postId: id, postUrl }] };
    }
    socket?.send(JSON.stringify({ id: message.id, result }));
  });
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  const platforms = ['wechat', 'zhihu', 'bilibili'] as const;
  const accounts: string[] = [];
  for (const platform of platforms) {
    const account = z.object({ id: z.uuid() }).parse(await post('publishing/draft-connectors/accounts', { platform, expectedUserId: `fixture-${platform === 'wechat' ? 'weixin' : platform}`, permissionConfirmed: true }));
    accounts.push(account.id);
  }
  const draft = await createDraft({ topic: 'Isolated connector acceptance', audience: 'Local test', angle: 'Verify draft-only transport', sources: [{ title: 'Web standards', url: 'https://www.w3.org/', excerpt: 'Public fixture source.' }], platforms: [...platforms] }, { title: 'Connector fixture', body: 'Fixture content.', variants: platforms.map(platform => ({ platform, title: 'Connector fixture', text: 'Fixture content.', tags: [], mediaPaths: [], format: 'article' })) });
  const input = { accountIds: accounts, expectedRevision: draft.revision };
  const first = z.array(z.object({ id: z.uuid() })).parse(await post(`drafts/${draft.id}/save-drafts`, input));
  assert.equal(first.length, 3); assert.equal((await listOperations(draft.id)).length, 3);
  for (let index = 0; index < 3; index++) assert.equal(await runWorkerOnce(), true);
  const state = await readState(); assert.equal(state.paused, true); assert.equal(writes, 3);
  for (const job of state.jobs) {
    assert.equal(job.status, 'draft_saved'); assert.equal(job.attempts, 1);
    assert.ok(job.draftReceipt?.id); assert.equal(job.draftReceipt?.verification, 'adapter_reported');
    assert.equal(job.remoteId, null); assert.equal(job.remoteUrl, null);
  }
  assert.equal(JSON.stringify(state).includes('fixture-secret'), false);
  const repeated = z.array(z.object({ id: z.uuid() })).parse(await post(`drafts/${draft.id}/save-drafts`, input));
  assert.deepEqual(repeated, first); assert.equal((await listOperations(draft.id)).length, 3);
  assert.equal(await runWorkerOnce(), false); assert.equal(writes, 3);
  assert.equal((await listOperations(draft.id)).every(operation => operation.status === 'succeeded'), true);
  console.log(JSON.stringify({ workspaceId, isolated: true, docker: true, supabase: true, durableOperations: 3, adapterDraftReceipts: 3, publicPosts: 0, duplicateWrites: 0, publishingPaused: true, realPlatformAcceptance: false }));
} finally {
  socket?.terminate(); await bridge.close();
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
