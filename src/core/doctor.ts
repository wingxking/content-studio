import { z } from 'zod';
import { modelExecutorOrigin } from './model-executor.ts';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { codexExecutable } from './generator.ts';
import { dataDirectory, readState, storageMode } from './store.ts';
import { dbRpc } from './database.ts';
import { listModels } from './models.ts';

export async function doctor(): Promise<Record<string, unknown>> {
  let codexAvailable = false; let codexPath: string | null = null;
  try { codexPath = await codexExecutable(); codexAvailable = true; } catch { /* Report availability without starting a generation. */ }
  let stateReadable = false; let localWritable = false; let storage = 'invalid'; let stateError: string | null = null;
  let paused: boolean | null = null; let connectedAccounts = 0; let localServices: unknown = null;
  try {
    storage = storageMode(); await mkdir(dataDirectory(), { recursive: true, mode: 0o700 }); await access(dataDirectory(), constants.W_OK); localWritable = true;
    const state = await readState(); stateReadable = true; paused = state.paused; connectedAccounts = state.accounts.filter(account => account.status === 'connected').length;
    if (storage === 'supabase') localServices = await dbRpc('studio_runtime_health');
  } catch (error) { stateError = error instanceof Error ? error.message : 'Storage check failed.'; }
  const models = await listModels().catch(() => []);
  let modelRunner: unknown = null;
  if (process.env.STUDIO_MODEL_EXECUTOR_URL) { try { const response = await fetch(`${modelExecutorOrigin()}/readyz`, { signal: AbortSignal.timeout(10000), redirect: 'error' }); modelRunner = await response.json() as unknown; codexAvailable = response.ok; codexPath = null; } catch { modelRunner = { ready: false, action: 'Start and authorize the isolated model-runner container.' }; } }
  const roleOperations = storage === 'supabase' ? await dbRpc('studio_operation_diagnostics').catch(() => null) : null;
  const scheduler = storage === 'supabase' ? await dbRpc('studio_scheduler_status').catch(() => null) : null;
  const schedulerReady = z.object({ ready: z.boolean() }).safeParse(scheduler);
  return { scheduler, schedulerReady: schedulerReady.success && schedulerReady.data.ready, stage: 1, requiredGoogleAccount: 'radarxai@gmail.com', codexAvailable, codexPath, modelCount: models.length,
    modelRunner, roleOperations, runtime: process.env.STUDIO_CONTAINER === 'true' ? 'docker' : 'migration-native', codexAuthentication: 'Container login readiness and a real model task are separate checks.', storage: 'localfs', database: storage, dataDirectory: dataDirectory(), stateReadable, localWritable, stateError, paused, connectedAccounts, localServices,
    postizConfigured: Boolean(process.env.POSTIZ_API_KEY), automaticTextPlatforms: process.env.POSTIZ_API_KEY ? ['x (非热点)', 'linkedin'] : [],
    sourceDiscovery: '统一一次/每天/每周任务，研究真实来源，最多 20 个有来源的选题；不声称全球热度排名。',
    youtubePublishing: '授权的 YouTube API + 持久上传记录；先手动制作真实视频，再点击发布。',
    xPolicy: '热点相关的 X 内容交由账号所有者在原生页面发布。',
    videoGeneration: 'Independent versioned storyboard, CPU TTS, MPT renderer, measured captions and explicit render approval.',
    stageTwoGate: '本地验收通过后才开始云端实施。' };
}
