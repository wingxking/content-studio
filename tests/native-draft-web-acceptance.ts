// Interactive native-platform acceptance. Never enables public publication.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mutateState, readState } from '../src/core/store.ts';
import { createDraft } from '../src/core/pipeline.ts';
import { createDraftBridge } from '../src/server/draft-bridge.ts';
import { initializeWorker, runWorkerOnce } from '../src/server/worker.ts';

assert(process.argv.includes('--confirm-private-draft-acceptance'));
assert.equal(new URL(process.env.SUPABASE_URL ?? '').hostname, 'kong');
const workspace = randomUUID();
const directory = join('/acceptance', workspace);
Object.assign(process.env, {
  STUDIO_WORKSPACE_ID: workspace, STUDIO_DATA_DIR: directory,
  STUDIO_LOCALFS_DIR: join(directory, 'media'), CODEX_HOME: join(directory, 'models'),
  STUDIO_DRAFT_BRIDGE_CONFIG: join(directory, 'private/bridge.json'),
  STUDIO_DRAFT_BRIDGE_PORT: '19528', STUDIO_DRAFT_BRIDGE_URL: 'http://127.0.0.1:8915',
  STUDIO_PUBLIC_ORIGIN: 'http://127.0.0.1:14411', STUDIO_LISTEN_HOST: '0.0.0.0', PORT: '4310',
  STUDIO_WORKER_ROLE: 'delivery', NODE_ENV: 'production',
});
delete process.env.POSTIZ_API_KEY;
delete process.env.STUDIO_MODEL_EXECUTOR_URL;
await mkdir(process.env.CODEX_HOME!, { recursive: true, mode: 0o700 });
await writeFile(join(process.env.CODEX_HOME!, 'studio-models.json'), JSON.stringify({ models: [] }));
await mutateState(state => { state.paused = true; });
const platforms = ['wechat', 'zhihu', 'bilibili'] as const;
const title = 'Content Studio 私密草稿验收 · 请勿发布';
const text = '这是一篇仅用于验证草稿保存的测试内容，请勿公开发布。\n\n验收项目：标题与正文正确、保存回执可追溯、重复操作不会重复创建草稿。\n\n测试完成后可由账号所有者在草稿箱中移除此测试内容。';
const draft = await createDraft({ topic: title, audience: 'Content Studio 账号所有者', angle: '核验私密草稿保存', sources: [{ title: 'W3C · 验收参考链接', url: 'https://www.w3.org/', excerpt: '仅验证来源链接在草稿中保留，不用于发布事实性文章。' }], platforms: [...platforms] }, { title, body: text, variants: platforms.map(platform => ({ platform, title, text, tags: [], mediaPaths: [], format: 'article' })) });
const bridge = createDraftBridge();
await bridge.start(); await initializeWorker();
const api = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: process.env, stdio: 'inherit' });
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
api.once('exit', () => controller.abort());
console.log(JSON.stringify({ nativeDraftAcceptance: 'started', workspace, draftId: draft.id, origin: process.env.STUDIO_PUBLIC_ORIGIN, directory, publicPublishingPaused: true }));
try {
  while (!controller.signal.aborted) {
    if (!await runWorkerOnce(controller.signal)) await delay(250, undefined, { signal: controller.signal }).catch(() => {});
  }
} finally {
  api.kill('SIGTERM'); await bridge.close();
  const state = await readState();
  assert.equal(state.paused, true);
  assert(state.jobs.every(job => job.deliveryAction === 'save_draft'));
  console.log(JSON.stringify({ nativeDraftAcceptance: 'stopped', workspace, publicPosts: 0, jobs: state.jobs.map(job => ({ id: job.id, platform: job.platform, status: job.status, draftReceipt: job.draftReceipt })) }));
  // Preserve this isolated workspace and private attempt journals for reconciliation.
}
