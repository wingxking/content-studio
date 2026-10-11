import { randomUUID } from 'node:crypto';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { z } from 'zod';
import { assetStore, assetWorkspace, presentAsset, uploadAssetStream } from '../core/assets.ts';
import { maximumAssetBytes, type LocalAssetStore } from '../core/localfs.ts';

type UploadServices = { store?: LocalAssetStore; workspaceId?: string; path?: string; ttlMs?: number; intakeCapacityBytes?: number };
export async function createUploadRouter(options: UploadServices = {}): Promise<Router> {
  const store = options.store ?? assetStore(); await store.initialize();
  const workspaceId = options.workspaceId ?? assetWorkspace(); const path = options.path ?? '/api/uploads';
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000; const capacity = options.intakeCapacityBytes ?? 2 * 1024 * 1024 * 1024;
  const files = new FileStore({ directory: store.intakeDirectory(), expirationPeriodInMilliseconds: ttl });
  const uploads = async (): Promise<string[]> => (await readdir(store.intakeDirectory())).filter(name => z.uuid().safeParse(name).success);
  const finalize = async (uploadId: string) => {
    const upload = await files.getUpload(z.uuid().parse(uploadId));
    if (upload.size === undefined || upload.offset !== upload.size) throw new Error('Upload is incomplete.');
    if (upload.metadata?.workspace !== workspaceId) throw new Error('Upload belongs to another workspace.');
    return store.finalize(upload.id, upload.metadata?.filename ?? 'Media', workspaceId, join(store.intakeDirectory(), upload.id), true);
  };
  // Sweep intake links only; immutable finalized objects remain authoritative.
  let sweeping: Promise<void> | undefined;
  const sweep = (): Promise<void> => {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const repair = await store.repair(); if (repair.failures.length) process.stderr.write(`LocalFS pending receipts require repair: ${repair.failures.length}\n`);
      for (const uploadId of await uploads()) {
        try {
          const upload = await files.getUpload(uploadId); if (upload.metadata?.workspace !== workspaceId) continue;
          const info = await stat(join(store.intakeDirectory(), uploadId));
          if (upload.size !== undefined && upload.offset === upload.size && (await store.receipt(uploadId))?.status !== 'finalized') await finalize(uploadId);
          if (Date.now() - info.mtimeMs > ttl) await files.remove(uploadId);
        } catch { /* A concurrent PATCH or expired receipt can disappear during the sweep. */ }
      }
    })().finally(() => { sweeping = undefined; }); return sweeping;
  };
  await sweep(); const cleanup = setInterval(() => { void sweep().catch(() => undefined); }, Math.max(1000, Math.min(ttl, 60000))); cleanup.unref();
  const tus = new Server({
    path, datastore: files, maxSize: maximumAssetBytes, relativeLocation: true, respectForwardedHeaders: false,
    disableTerminationForFinishedUploads: true, namingFunction: () => randomUUID(),
    onUploadCreate: async (_request, upload) => {
      if (!upload.size || upload.size > maximumAssetBytes) throw { status_code: 413, body: 'Declare a non-empty upload up to 500 MiB.' };
      const filename = z.string().min(1).max(200).parse(upload.metadata?.filename ?? upload.metadata?.name);
      await sweep(); let reserved = 0;
      for (const id of await uploads()) { const current = await files.getUpload(id); const receipt = await store.receipt(id); if (receipt?.status === 'finalized') continue; reserved += current.size ?? maximumAssetBytes; }
      const disk = await statfs(store.root);
      if (reserved + upload.size > capacity || disk.bavail * disk.bsize < upload.size) throw { status_code: 413, body: 'Local upload capacity is full. Complete or remove unfinished uploads.' };
      return { metadata: { filename, workspace: workspaceId } };
    },
    onIncomingRequest: async (request, uploadId) => {
      if (request.method === 'POST' || !uploadId) return;
      z.uuid().parse(uploadId);
      const upload = await files.getUpload(uploadId);
      if (upload.metadata?.workspace !== workspaceId) throw { status_code: 404, body: 'Upload not found.' };
    },
    onUploadFinish: async (_request, upload) => { const record = await finalize(upload.id); return { headers: { 'X-Asset-Id': record.id } }; },
    exposedHeaders: ['X-Asset-Id'],
    onResponseError: (_request, error) => 'status_code' in error ? undefined : { status_code: 400, body: error.message },
  });
  const router = Router();
  router.get(`${path}/:id/asset`, async (request, response) => {
    const id = z.uuid().parse(request.params.id); let record = await store.receipt(id);
    if (!record || record.status !== 'finalized') record = await finalize(id);
    if (record.workspace_id !== workspaceId) throw new Error('Upload not found.');
    await store.verify(record); response.json({ asset: presentAsset(record), reference: `studio-asset:${record.id}` });
  });
  router.all(path, async (request, response) => { await tus.handle(request, response); });
  router.all(`${path}/:id`, async (request, response) => { await tus.handle(request, response); });
  return router;
}
// Mount before express.json; IncomingMessage streams directly to disk and never becomes a whole-file Buffer.
export function createStreamingAssetRouter(): Router {
  const router = Router();
  router.post('/api/assets', async (request, response) => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new Error('Upload application/octet-stream media.');
    const name = z.string().min(1).max(600).parse(request.headers['x-file-name']);
    response.json(await uploadAssetStream(decodeURIComponent(name), request));
  });
  return router;
}
