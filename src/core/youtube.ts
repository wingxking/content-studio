import { withJobExecution, markAccountDispatch, accountExecutionSignal } from './account-execution.ts';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { markYouTubeJournalPresence } from './publication-journal.ts';
import { type Job, type StudioState } from './model.ts';
import { exportJob, verifyDraftApproval } from './pipeline.ts';
import { resolveMediaLocation } from './media-location.ts';
import { dataDirectory, mutateState, readState } from './store.ts';
import { createVerificationCheck } from './publication-checks.ts';
import { desktopYouTubeTokenProvider, readPrivateJson, writePrivateJson } from './youtube-oauth.ts';

export const expectedYouTubeChannelId = 'UCVUtH6reLkEuMrUuTh-XgjQ';
export const youtubeSettingsSchema = z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']), selfDeclaredMadeForKids: z.boolean(), containsSyntheticMedia: z.boolean(), categoryId: z.string().regex(/^\d+$/), defaultLanguage: z.string().min(2).max(20), descriptionDisclosure: z.string().trim().min(10).max(1000) }).strict();
type Settings = z.infer<typeof youtubeSettingsSchema>;
const videoIdSchema = z.string().regex(/^[\w-]{11}$/);
const journalSchema = z.object({ version: z.literal(1), jobId: z.uuid(), channelId: z.literal(expectedYouTubeChannelId), approvedHash: z.string(), mediaHash: z.string(), mediaBytes: z.number().int().positive(), offset: z.number().int().nonnegative().default(0), metadata: z.object({ snippet: z.object({ title: z.string(), description: z.string(), tags: z.array(z.string()), categoryId: z.string(), defaultLanguage: z.string() }), status: youtubeSettingsSchema.omit({ categoryId: true, defaultLanguage: true, descriptionDisclosure: true }) }), phase: z.enum(['starting', 'session_ready', 'sending', 'uploaded', 'needs_reconciliation']), sessionUrl: z.string().nullable(), videoId: videoIdSchema.nullable(), at: z.iso.datetime() });
type Journal = z.infer<typeof journalSchema>;
type Transport = { fetcher?: typeof fetch; tokenProvider?: () => Promise<string>; signal?: AbortSignal; readOnly?: boolean };
const now = (): string => new Date().toISOString();
const privateRoot = (): string => join(dataDirectory(), 'youtube');
const journalPath = (jobId: string): string => join(privateRoot(), 'uploads', `${z.uuid().parse(jobId)}.json`);
const findJob = (state: StudioState, id: string): Job => { const job = state.jobs.find(item => item.id === id); if (!job) throw new Error('Job not found.'); return job; };
function move(job: Job, status: Job['status'], message: string): void { if (job.verificationCheck && ['published', 'failed', 'cancelled', 'needs_reconciliation'].includes(status)) { job.verificationCheck.nextAt = null; job.verificationCheck.stoppedReason = status === 'needs_reconciliation' ? 'uncertain' : 'terminal'; } job.status = status; job.error = status === 'needs_reconciliation' || status === 'failed' ? message : null; job.submissionOwner = null; job.submissionLeaseUntil = null; job.history.push({ at: now(), status, message }); }
function transport(input: Transport): { fetcher: typeof fetch; tokenProvider: () => Promise<string>; signal?: AbortSignal } { const original = input.fetcher ?? fetch; const fetcher: typeof fetch = input.signal ? (url, init) => original(url, { ...init, signal: AbortSignal.any([input.signal!, ...init?.signal ? [init.signal] : []]) }) : original; return { fetcher, tokenProvider: input.tokenProvider ?? desktopYouTubeTokenProvider(join(privateRoot(), 'secrets'), fetcher), signal: input.signal }; }
async function boundTransport(input: Transport): Promise<ReturnType<typeof transport>> {
  const io = transport(input);
  let bearer: string;
  try { bearer = await io.tokenProvider(); }
  catch { throw new Error('YouTube authorization is unavailable; authorize the expected channel before uploading or reconciling.'); }
  return { fetcher: io.fetcher, tokenProvider: async () => bearer, signal: io.signal };
}
function journalMatchesJob(job: Job, journal: Journal): boolean {
  return job.id === journal.jobId && job.platform === 'youtube' && job.provider === 'native' && job.approvedHash === journal.approvedHash
    && job.snapshot?.account.id === job.accountId && job.snapshot.account.integrationId === journal.channelId
    && job.snapshot.account.platform === 'youtube' && job.snapshot.account.provider === 'native' && (job.snapshot.video ? job.snapshot.video.projectId === job.subject?.id && job.subject.kind === 'video' : job.snapshot.draft?.id === job.draftId)
    && (!job.providerPostId || !journal.videoId || job.providerPostId === journal.videoId)
    && (!job.remoteId || !journal.videoId || job.remoteId === journal.videoId);
}
function jobFingerprint(job: Job): string {
  return JSON.stringify([job.status, job.approvedHash, job.accountId, job.draftId, job.snapshot?.account.integrationId,
    job.providerPostId, job.remoteId, job.remoteUrl, job.submissionOwner, job.submissionStartedAt, job.history.length]);
}
function liveSubmissionOwner(job: Job): boolean {
  if (job.status === 'submitting' && job.submissionLeaseUntil) return Date.parse(job.submissionLeaseUntil) > Date.now();
  if (job.status !== 'submitting' || !job.submissionOwner) return false;
  const [host, pid] = job.submissionOwner.split(':');
  if (host !== hostname() || !pid || !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}
async function call(url: string, init: RequestInit, io: ReturnType<typeof transport>): Promise<Response> {
  try { return await io.fetcher(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await io.tokenProvider()}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(init.method === 'PUT' ? 120000 : 30000), ...io.signal ? [io.signal] : [], ...accountExecutionSignal() ? [accountExecutionSignal()!] : []]) }); }
  catch { throw new Error('YouTube request failed; reconcile the saved upload before any new submission.'); }
}
async function parsed<T>(response: Response, schema: z.ZodType<T>): Promise<T> { try { return schema.parse(await response.json()); } catch { throw new Error('YouTube returned an invalid response; reconcile the saved upload.'); } }
export async function verifyYouTubeChannel(input: Transport = {}): Promise<{ channelId: string }> {
  const response = await call('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { method: 'GET' }, transport(input));
  if (!response.ok) throw new Error(`YouTube channel verification failed (HTTP ${response.status}).`);
  const reply = await parsed(response, z.object({ items: z.array(z.object({ id: z.string() })), nextPageToken: z.string().optional() }));
  if (reply.nextPageToken || reply.items.length !== 1 || reply.items[0]?.id !== expectedYouTubeChannelId) throw new Error('OAuth selected a different or ambiguous YouTube channel. Authorize the expected channel before uploading.');
  return { channelId: expectedYouTubeChannelId };
}
function validatedSession(value: string): string { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com' || url.port || url.username || url.password || !/^\/(?:resumable\/)?upload\/youtube\/v3\/videos$/.test(url.pathname)) throw new Error('YouTube upload session endpoint was not trusted.'); return url.toString(); }
async function loadJournal(id: string): Promise<Journal | null> {
  let saved: unknown;
  try { saved = await readPrivateJson(journalPath(id)); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw new Error('YouTube upload journal is invalid; preserve it and inspect before any upload.'); }
  const marker = z.object({ jobId: z.uuid(), restoredJournalMarker: z.literal(true) }).safeParse(saved);
  if (marker.success && marker.data.jobId === id) throw new Error('This restored upload has a journal-presence marker. Restore its encrypted private journal with --restore-private, or inspect the existing upload in YouTube Studio and record the verified receipt; do not start another upload.');
  try { return journalSchema.parse(saved); }
  catch { throw new Error('YouTube upload journal is invalid; preserve it and inspect before any upload.'); }
}
async function saveJournal(journal: Journal): Promise<void> { await markYouTubeJournalPresence(journal.jobId); await writePrivateJson(journalPath(journal.jobId), journalSchema.parse({ ...journal, at: now() })); }
async function failUnknown(id: string, expectedFingerprint?: string, submissionOwner?: string): Promise<Job> {
  return mutateState(state => {
    const job = findJob(state, id);
    if (expectedFingerprint !== undefined && jobFingerprint(job) !== expectedFingerprint) return job;
    if (submissionOwner !== undefined && (job.status !== 'submitting' || job.submissionOwner !== submissionOwner)) return job;
    move(job, 'needs_reconciliation', 'YouTube outcome is uncertain. Reconcile the saved session/video; the historical receipt is preserved and no new upload is authorized.');
    return job;
  });
}
async function readAcceptedUpload(id: string, input: Transport): Promise<Job> {
  try { return await reconcileYouTubeJob(id, { ...input, readOnly: true }); }
  catch (error) {
    return mutateState(state => {
      const job = findJob(state, id);
      if (!job.remoteId || !['queued', 'delivered'].includes(job.status) || !job.verificationCheck) throw error;
      const permission = error instanceof Error && /HTTP\s*(?:401|403)|auth|permission|different.*channel|ambiguous.*channel/iu.test(error.message);
      job.verificationCheck.attempt++; job.verificationCheck.checkedAt = now();
      job.verificationCheck.lastError = permission ? '授权或目标账号需要复核，自动核验已停止。' : '首次远端查询暂不可用，已受理的视频保留，等待只读核验。';
      job.verificationCheck.nextAt = permission ? null : new Date(Date.now() + 120_000).toISOString();
      job.verificationCheck.stoppedReason = permission ? 'permission_required' : null;
      return job;
    });
  }
}
async function verifyCurrent(state: StudioState, job: Job): Promise<void> {
  if (state.paused) throw new Error('Publishing is paused.');
  const snapshot = job.snapshot; const draft = state.drafts.find(item => item.id === job.draftId); const account = state.accounts.find(item => item.id === job.accountId);
  if (!snapshot || (!draft && !snapshot.video) || !account || job.platform !== 'youtube' || job.provider !== 'native' || account.platform !== 'youtube' || account.provider !== 'native' || account.status !== 'connected' || account.integrationId !== expectedYouTubeChannelId) throw new Error('Use a connected native YouTube account with the verified channel ID and an immutable job snapshot.');
  if (snapshot.video) {
    const { verifyVideoDeliveryApproval } = await import('./video-delivery.ts');
    await verifyVideoDeliveryApproval(job);
    if (account.id !== snapshot.account.id || account.label !== snapshot.account.label || account.integrationId !== snapshot.account.integrationId) throw new Error('Video target account changed; approve it again.');
    return;
  }
  if (!snapshot.draft) throw new Error('Article approval snapshot is missing.');
  if (!draft) throw new Error('Draft not found.');
  await verifyDraftApproval(draft);
  if (draft.approvedHash !== snapshot.draft.approvedHash || draft.revision !== snapshot.draft.revision || account.id !== snapshot.account.id || account.label !== snapshot.account.label || account.integrationId !== snapshot.account.integrationId || account.provider !== snapshot.account.provider || account.platform !== snapshot.account.platform) throw new Error('Draft/media approval or account target changed; schedule the reviewed version.');
}
export async function hashMedia(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
function assertAccountAvailable(state: StudioState, job: Job): void {
  if (state.jobs.some(other => other.id !== job.id && other.accountId === job.accountId && ['submitting', 'needs_reconciliation'].includes(other.status))) throw new Error('Another publication owns this account or has an unknown outcome. Reconcile it first.');
}
const chunkBytes = 8 * 1024 * 1024;
function confirmedOffset(response: Response, bytes: number): number {
  const range = response.headers.get('Range');
  if (!range) return 0;
  const match = /^bytes=0-([0-9]+)$/.exec(range);
  const offset = match?.[1] ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes) throw new Error('Upload session returned an invalid offset.');
  return offset;
}
async function sendChunks(journal: Journal, path: string, io: ReturnType<typeof transport>, verifyOwner: () => Promise<void>): Promise<{ id: string }> {
  if (!journal.sessionUrl) throw new Error('No resumable session exists.');
  const file = await open(path, 'r');
  try {
    while (journal.offset < journal.mediaBytes) {
      await verifyOwner();
      const offset = journal.offset; const length = Math.min(chunkBytes, journal.mediaBytes - offset);
      const buffer = Buffer.alloc(length); const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error('Approved video changed or became unavailable.');
      journal.phase = 'sending'; await saveJournal(journal);
      const reply = await call(validatedSession(journal.sessionUrl), { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${journal.mediaBytes}` }, body: new Uint8Array(buffer).buffer }, io);
      if ([200, 201].includes(reply.status)) {
        const result = await parsed(reply, z.object({ id: videoIdSchema })); journal.offset = journal.mediaBytes; journal.videoId = result.id; journal.phase = 'uploaded'; await saveJournal(journal); return result;
      }
      if (reply.status !== 308) throw new Error('Upload chunk outcome requires session reconciliation.');
      const acknowledged = confirmedOffset(reply, journal.mediaBytes);
      if (acknowledged <= offset || acknowledged > offset + length) throw new Error('Upload session did not acknowledge this chunk.');
      journal.offset = acknowledged; await saveJournal(journal);
    }
    throw new Error('Upload has no final video receipt. Reconcile the existing session.');
  } finally { await file.close(); }
}
function renewSubmissionLease(id: string, owner: string): { stop: () => void; assert: () => void } {
  let busy = false; let failure: Error | null = null;
  const timer = setInterval(() => { if (busy) return; busy = true; void mutateState(state => { const job = findJob(state, id); if (job.status !== 'submitting' || job.submissionOwner !== owner) throw new Error('Upload ownership changed.'); job.submissionLeaseUntil = new Date(Date.now() + 180000).toISOString(); }).catch(() => { failure = new Error('Upload lease renewal failed; reconcile the existing session.'); }).finally(() => { busy = false; }); }, 10000); timer.unref();
  return { stop: () => clearInterval(timer), assert: () => { if (failure) throw failure; } };
}
// Explicit continuation only: probe the existing session, retain the same job/session, never insert another video.
async function resumeYouTubeJobOwned(id: string, input: Transport = {}): Promise<Job> {
  const journal = await loadJournal(id); if (!journal?.sessionUrl || journal.videoId) return reconcileYouTubeJob(id, input);
  const job = findJob(await readState(), id);
  if (!journalMatchesJob(job, journal) || liveSubmissionOwner(job)) throw new Error('Saved upload is mismatched or still owned.');
  const io = await boundTransport(input); await verifyYouTubeChannel(io);
  const probe = await call(validatedSession(journal.sessionUrl), { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${journal.mediaBytes}` } }, io);
  if ([200, 201].includes(probe.status)) {
    journal.videoId = (await parsed(probe, z.object({ id: videoIdSchema }))).id; journal.phase = 'uploaded'; await saveJournal(journal);
    await mutateState(state => {
      const current = findJob(state, id);
      if (jobFingerprint(current) !== jobFingerprint(job) || !journalMatchesJob(current, journal) || !['submitting', 'queued', 'needs_reconciliation', 'delivered'].includes(current.status)) throw new Error('Completed upload recovery changed; inspect the saved video before continuing.');
      current.providerPostId = journal.videoId; current.remoteId = journal.videoId; current.verificationCheck ??= createVerificationCheck();
      move(current, 'queued', 'Existing upload session returned its completed video ID; verifying the original video.');
    });
    return readAcceptedUpload(id, io);
  }
  if (probe.status !== 308) return failUnknown(id);
  const bundle = await exportJob(id);
  await verifyCurrent(await readState(), bundle.job);
  const media = await Promise.all(bundle.variant.mediaPaths.map(resolveMediaLocation)); const files: string[] = [];
  for (const path of media) { const file = await open(path, 'r'); const header = Buffer.alloc(8); try { await file.read(header, 0, 8, 0); } finally { await file.close(); } if (header.toString('ascii', 4, 8) === 'ftyp') files.push(path); }
  if (files.length !== 1 || !files[0] || await hashMedia(files[0]) !== journal.mediaHash || (await stat(files[0])).size !== journal.mediaBytes) throw new Error('Saved upload media changed; review it before any continuation.');
  const path = files[0]; const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  await mutateState(async state => { const current = findJob(state, id); if (jobFingerprint(current) !== jobFingerprint(job)) throw new Error('Job changed during recovery.'); await verifyCurrent(state, current); assertAccountAvailable(state, current); current.status = 'submitting'; current.submissionOwner = owner; current.submissionStartedAt = now(); current.submissionLeaseUntil = new Date(Date.now() + 180000).toISOString(); });
  const lease = renewSubmissionLease(id, owner);
  try {
    await markAccountDispatch();
    journal.offset = confirmedOffset(probe, journal.mediaBytes); await saveJournal(journal);
    const result = await sendChunks(journal, path, io, async () => { lease.assert(); const state = await readState(); const current = findJob(state, id); if (state.paused || current.submissionOwner !== owner || current.status !== 'submitting') throw new Error('Upload ownership changed or publishing paused.'); });
    await mutateState(state => { const current = findJob(state, id); if (current.submissionOwner !== owner) throw new Error('Upload ownership changed.'); current.providerPostId = result.id; current.remoteId = result.id; current.verificationCheck = createVerificationCheck(); move(current, 'queued', 'Existing resumable upload completed; verifying remote receipt.'); });
    return readAcceptedUpload(id, io);
  } catch { await failUnknown(id, undefined, owner); throw new Error('Upload continuation requires reconciliation; existing session preserved.'); } finally { lease.stop(); }
}
async function uploadYouTubeJobOwned(id: string, settingsInput: Settings, input: Transport = {}): Promise<Job> {
  const settings = youtubeSettingsSchema.parse(settingsInput);
  if (await loadJournal(id)) throw new Error('A durable YouTube upload journal already exists. Reconcile it; this command never starts a second upload.');
  const bundle = await exportJob(id);
  if (bundle.job.snapshot?.video && 'hashVersion' in bundle.job.snapshot.video) {
    const { approvedVideoUploadSettings } = await import('./video-delivery.ts');
    approvedVideoUploadSettings(bundle.job, settings);
  }
  await verifyCurrent(await readState(), bundle.job);
  const resolvedFiles = await Promise.all(bundle.variant.mediaPaths.map(resolveMediaLocation));
  const files = resolvedFiles.filter(path => /\.mp4$/i.test(path));
  if (files.length !== 1 || !files[0]) throw new Error('Attach exactly one reviewed MP4 to this YouTube variant.');
  const info = await stat(files[0]);
  if (!info.isFile() || info.size <= 32 || info.size > 8 * 1024 * 1024 * 1024) throw new Error('The stage-one uploader supports a non-empty MP4 up to 8 GiB.');
  const mediaFile = files[0];
  const handle = await open(mediaFile, 'r'); const header = Buffer.alloc(12);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('The approved media is not an MP4 container.');
  const mediaHash = await hashMedia(mediaFile);
  const description = `${bundle.variant.text}\n\n${settings.descriptionDisclosure}\n\nSources:\n${(bundle.draft?.brief.sources ?? bundle.job.snapshot?.video?.sources ?? []).map(source => source.url).join('\n')}`;
  if (!bundle.variant.title.trim() || [...bundle.variant.title].length > 100 || /[<>]/.test(bundle.variant.title) || /[<>]/.test(description) || Buffer.byteLength(description) > 5000 || bundle.variant.tags.join(',').length > 400) throw new Error('Reviewed YouTube metadata exceeds supported API limits; edit and approve the draft before uploading.');
  const io = await boundTransport(input);
  await verifyYouTubeChannel(io);
  const journal: Journal = { version: 1, jobId: id, channelId: expectedYouTubeChannelId, approvedHash: bundle.job.approvedHash, mediaHash, mediaBytes: info.size, offset: 0, metadata: { snippet: { title: bundle.variant.title, description, tags: bundle.variant.tags, categoryId: settings.categoryId, defaultLanguage: settings.defaultLanguage }, status: { privacyStatus: settings.privacyStatus, selfDeclaredMadeForKids: settings.selfDeclaredMadeForKids, containsSyntheticMedia: settings.containsSyntheticMedia } }, phase: 'starting', sessionUrl: null, videoId: null, at: now() };
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  await mutateState(async state => {
    const job = findJob(state, id); if (!['scheduled', 'awaiting_operator'].includes(job.status)) throw new Error('This YouTube job is already submitted or cannot be uploaded.');
    await verifyCurrent(state, job);
    if (await hashMedia(mediaFile) !== mediaHash) throw new Error('Video changed while preflight was running; review and approve again.');
    assertAccountAvailable(state, job);
    job.status = 'submitting'; job.attempts++; job.submissionOwner = owner; job.submissionStartedAt = now(); job.submissionLeaseUntil = new Date(Date.now() + 180000).toISOString(); job.error = null;
    job.history.push({ at: now(), status: 'submitting', message: 'Official YouTube upload claimed; durable reconciliation is required after any unknown outcome.' });
  });
  const lease = renewSubmissionLease(id, owner);
  try {
    await markAccountDispatch();
    await saveJournal(journal);
    const started = await call('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(info.size), 'X-Upload-Content-Type': 'video/mp4' }, body: JSON.stringify(journal.metadata) }, io);
    if (!started.ok) throw new Error(`YouTube session request returned HTTP ${started.status}.`);
    const location = started.headers.get('Location'); if (!location) throw new Error('YouTube session response had no location.');
    journal.sessionUrl = validatedSession(location); journal.phase = 'session_ready'; await saveJournal(journal);
    await mutateState(async state => { const job = findJob(state, id); if (job.status !== 'submitting' || job.submissionOwner !== owner || !journalMatchesJob(job, journal)) throw new Error('YouTube submission ownership or snapshot changed before media upload.'); await verifyCurrent(state, job); job.submissionStartedAt = now(); });
    journal.phase = 'sending'; await saveJournal(journal);
    const reply = await sendChunks(journal, mediaFile, io, async () => { lease.assert(); const state = await readState(); const current = findJob(state, id); if (state.paused || current.status !== 'submitting' || current.submissionOwner !== owner) throw new Error('Submission ownership changed.'); });
    await mutateState(state => {
      const job = findJob(state, id);
      if (job.status !== 'submitting' || job.submissionOwner !== owner || !journalMatchesJob(job, journal)) throw new Error('YouTube submission ownership or snapshot changed after media upload; reconcile the saved video.');
      job.providerPostId = reply.id; job.remoteId = reply.id; job.verificationCheck = createVerificationCheck(); move(job, 'queued', 'YouTube returned a video ID; processing and public visibility are not yet verified.');
    });
    return readAcceptedUpload(id, io);
  } catch {
    // Never issue another session POST, even when the first response was lost.
    await failUnknown(id, undefined, owner);
    throw new Error('YouTube upload did not finish with verified publication. The job is preserved for reconciliation; no automatic retry was performed.');
  } finally { lease.stop(); }
}
async function reconcileYouTubeJobOwned(id: string, input: Transport = {}): Promise<Job> {
  const journal = await loadJournal(id); if (!journal) throw new Error('No saved YouTube upload journal exists for this job.');
  const initial = findJob(await readState(), id);
  if (input.readOnly && (initial.deliveryAction || !initial.remoteId || journal.videoId !== initial.remoteId || !['queued', 'delivered'].includes(initial.status))) throw new Error('Automatic readback requires a confirmed video identifier and matching saved journal.');
  if (!journalMatchesJob(initial, journal) || !['submitting', 'queued', 'needs_reconciliation', 'delivered', 'published'].includes(initial.status)) throw new Error('YouTube reconciliation does not match this job snapshot.');
  if (liveSubmissionOwner(initial)) throw new Error('The YouTube submission owner is still running; wait for it to finish before reconciliation.');
  const fingerprint = jobFingerprint(initial);
  const io = await boundTransport(input);
  await verifyYouTubeChannel(io);
  if (!journal.videoId && journal.sessionUrl) {
    if (input.readOnly) throw new Error('Automatic readback never probes or resumes an upload session.');
    const probed = await call(validatedSession(journal.sessionUrl), { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${journal.mediaBytes}` } }, io);
    if ([200, 201].includes(probed.status)) { const reply = await parsed(probed, z.object({ id: videoIdSchema })); journal.videoId = reply.id; journal.phase = 'uploaded'; await saveJournal(journal); }
    else return failUnknown(id, fingerprint);
  }
  if (!journal.videoId) return failUnknown(id, fingerprint);
  const response = await call(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${journal.videoId}`, { method: 'GET' }, io);
  if (!response.ok) { if (input.readOnly) throw new Error(`YouTube readback unavailable (HTTP ${response.status}).`); return failUnknown(id, fingerprint); }
  const reply = await parsed(response, z.object({ items: z.array(z.object({ id: videoIdSchema, snippet: z.object({ channelId: z.string() }), status: z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']), uploadStatus: z.enum(['uploaded', 'processed', 'failed', 'rejected', 'deleted']) }), processingDetails: z.object({ processingStatus: z.enum(['processing', 'succeeded', 'failed', 'terminated']) }).optional() })) }));
  const video = reply.items[0];
  if (reply.items.length !== 1 || !video || video.id !== journal.videoId || video.snippet.channelId !== expectedYouTubeChannelId) return failUnknown(id, fingerprint);
  return mutateState(state => {
    const job = findJob(state, id);
    if (jobFingerprint(job) !== fingerprint || !journalMatchesJob(job, journal)) return job;
    job.providerPostId = video.id; job.visibility = video.status.privacyStatus;
    if (['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus) || video.processingDetails?.processingStatus === 'failed') { move(job, 'needs_reconciliation', 'YouTube reported a rejected/failed/deleted video; inspect the existing video before any new upload.'); return job; }
    if (video.status.privacyStatus === 'public' && video.status.uploadStatus === 'processed' && video.processingDetails?.processingStatus !== 'processing') { job.remoteId = video.id; job.remoteUrl = `https://www.youtube.com/watch?v=${video.id}`; move(job, 'published', 'Official YouTube API readback confirmed matching channel, processed upload and public privacy. Viewer playback and geographic restrictions need separate acceptance.'); }
    else if (video.status.uploadStatus === 'processed' && video.processingDetails?.processingStatus !== 'processing' && video.status.privacyStatus !== 'public') { job.remoteId = video.id; job.remoteUrl = `https://www.youtube.com/watch?v=${video.id}`; move(job, 'delivered', `YouTube confirmed the video was processed with ${video.status.privacyStatus} visibility. It was uploaded successfully and is not publicly published.`); }
    else if (job.status === 'published' || (job.status !== 'delivered' && job.remoteId && job.remoteUrl)) move(job, 'needs_reconciliation', `Previously confirmed YouTube video now has API privacy ${video.status.privacyStatus} and upload status ${video.status.uploadStatus}; inspect its current visibility. The historical publication receipt is preserved.`);
    else move(job, 'queued', `YouTube video exists; API privacy is ${video.status.privacyStatus} and upload status is ${video.status.uploadStatus}. Public publication is not yet confirmed.`);
    return job;
  });
}

export async function uploadYouTubeJob(id: string, settingsInput: Settings, input: Transport = {}): Promise<Job> { return withJobExecution(id, 'write', () => uploadYouTubeJobOwned(id, settingsInput, input)); }

export async function resumeYouTubeJob(id: string, input: Transport = {}): Promise<Job> { return withJobExecution(id, 'resume', () => resumeYouTubeJobOwned(id, input)); }

export async function reconcileYouTubeJob(id: string, input: Transport = {}): Promise<Job> { return withJobExecution(id, 'reconcile', () => reconcileYouTubeJobOwned(id, input)); }

export async function collectYouTubeJobMetrics(id: string, input: Transport = {}) {
  const job = findJob(await readState(), id);
  if (job.deliveryAction || !['published', 'delivered'].includes(job.status) || !job.remoteId || job.snapshot?.account.integrationId !== expectedYouTubeChannelId) throw new Error('A confirmed video for the intended channel is required.');
  const io = await boundTransport(input); await verifyYouTubeChannel(io);
  const response = await call(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIdSchema.parse(job.remoteId)}`, { method: 'GET' }, io);
  if (response.status === 429) { const error = new Error('The platform rate limit deferred metrics collection.'); Object.assign(error, { metricCode: 'RATE_LIMIT', retryAfter: response.headers.get('Retry-After') }); throw error; }
  if ([401, 403].includes(response.status)) { const error = new Error('Renew the expected channel authorization before collecting metrics.'); Object.assign(error, { metricCode: 'AUTH_REQUIRED' }); throw error; }
  if (!response.ok) throw new Error('The platform metrics request failed.');
  const count = z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger).optional();
  const data = await parsed(response, z.object({ items: z.array(z.object({ id: videoIdSchema, snippet: z.object({ channelId: z.string() }), statistics: z.object({ viewCount: count, likeCount: count, commentCount: count }) })) }));
  const item = data.items.find(value => value.id === job.remoteId && value.snippet.channelId === expectedYouTubeChannelId);
  if (!item) throw new Error('The confirmed work is unavailable for the expected account.');
  return { views: item.statistics.viewCount ?? null, likes: item.statistics.likeCount ?? null, comments: item.statistics.commentCount ?? null, shares: null, favorites: null, clicks: null, definition: 'YouTube Data API videos.statistics', adapterVersion: 'youtube-v1', source: 'official_api' as const };
}
