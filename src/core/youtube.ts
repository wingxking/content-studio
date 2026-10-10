import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type Job, type StudioState } from './model.ts';
import { exportJob, verifyDraftApproval } from './pipeline.ts';
import { dataDirectory, mutateState, readState } from './store.ts';
import { desktopYouTubeTokenProvider, readPrivateJson, writePrivateJson } from './youtube-oauth.ts';

export const expectedYouTubeChannelId = 'UCVUtH6reLkEuMrUuTh-XgjQ';
export const youtubeSettingsSchema = z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']), selfDeclaredMadeForKids: z.boolean(), containsSyntheticMedia: z.boolean(), categoryId: z.string().regex(/^\d+$/), defaultLanguage: z.string().min(2).max(20), descriptionDisclosure: z.string().trim().min(10).max(1000) }).strict();
type Settings = z.infer<typeof youtubeSettingsSchema>;
const videoIdSchema = z.string().regex(/^[\w-]{11}$/);
const journalSchema = z.object({ version: z.literal(1), jobId: z.uuid(), channelId: z.literal(expectedYouTubeChannelId), approvedHash: z.string(), mediaHash: z.string(), mediaBytes: z.number().int().positive(), metadata: z.object({ snippet: z.object({ title: z.string(), description: z.string(), tags: z.array(z.string()), categoryId: z.string(), defaultLanguage: z.string() }), status: youtubeSettingsSchema.omit({ categoryId: true, defaultLanguage: true, descriptionDisclosure: true }) }), phase: z.enum(['starting', 'session_ready', 'sending', 'uploaded', 'needs_reconciliation']), sessionUrl: z.string().nullable(), videoId: videoIdSchema.nullable(), at: z.iso.datetime() });
type Journal = z.infer<typeof journalSchema>;
type Transport = { fetcher?: typeof fetch; tokenProvider?: () => Promise<string> };
const now = (): string => new Date().toISOString();
const privateRoot = (): string => join(dataDirectory(), 'youtube');
const journalPath = (jobId: string): string => join(privateRoot(), 'uploads', `${z.uuid().parse(jobId)}.json`);
const findJob = (state: StudioState, id: string): Job => { const job = state.jobs.find(item => item.id === id); if (!job) throw new Error('Job not found.'); return job; };
function move(job: Job, status: Job['status'], message: string): void { job.status = status; job.error = status === 'needs_reconciliation' || status === 'failed' ? message : null; job.submissionOwner = null; job.history.push({ at: now(), status, message }); }
function transport(input: Transport): { fetcher: typeof fetch; tokenProvider: () => Promise<string> } { const fetcher = input.fetcher ?? fetch; return { fetcher, tokenProvider: input.tokenProvider ?? desktopYouTubeTokenProvider(join(privateRoot(), 'secrets'), fetcher) }; }
async function boundTransport(input: Transport): Promise<ReturnType<typeof transport>> {
  const io = transport(input);
  let bearer: string;
  try { bearer = await io.tokenProvider(); }
  catch { throw new Error('YouTube authorization is unavailable; authorize the expected channel before uploading or reconciling.'); }
  return { fetcher: io.fetcher, tokenProvider: async () => bearer };
}
function journalMatchesJob(job: Job, journal: Journal): boolean {
  return job.id === journal.jobId && job.platform === 'youtube' && job.provider === 'native' && job.approvedHash === journal.approvedHash
    && job.snapshot?.account.id === job.accountId && job.snapshot.account.integrationId === journal.channelId
    && job.snapshot.account.platform === 'youtube' && job.snapshot.account.provider === 'native' && job.snapshot.draft.id === job.draftId
    && (!job.providerPostId || !journal.videoId || job.providerPostId === journal.videoId)
    && (!job.remoteId || !journal.videoId || job.remoteId === journal.videoId);
}
function jobFingerprint(job: Job): string {
  return JSON.stringify([job.status, job.approvedHash, job.accountId, job.draftId, job.snapshot?.account.integrationId,
    job.providerPostId, job.remoteId, job.remoteUrl, job.submissionOwner, job.submissionStartedAt, job.history.length]);
}
function liveSubmissionOwner(job: Job): boolean {
  if (job.status !== 'submitting' || !job.submissionOwner) return false;
  const [host, pid] = job.submissionOwner.split(':');
  if (host !== hostname() || !pid || !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}
async function call(url: string, init: RequestInit, io: ReturnType<typeof transport>): Promise<Response> {
  try { return await io.fetcher(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await io.tokenProvider()}` }, redirect: 'error', signal: AbortSignal.timeout(init.method === 'PUT' ? 120000 : 30000) }); }
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
async function loadJournal(id: string): Promise<Journal | null> { try { return journalSchema.parse(await readPrivateJson(journalPath(id))); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw new Error('YouTube upload journal is invalid; preserve it and inspect before any upload.'); } }
async function saveJournal(journal: Journal): Promise<void> { await writePrivateJson(journalPath(journal.jobId), journalSchema.parse({ ...journal, at: now() })); }
async function failUnknown(id: string, expectedFingerprint?: string, submissionOwner?: string): Promise<Job> {
  return mutateState(state => {
    const job = findJob(state, id);
    if (expectedFingerprint !== undefined && jobFingerprint(job) !== expectedFingerprint) return job;
    if (submissionOwner !== undefined && (job.status !== 'submitting' || job.submissionOwner !== submissionOwner)) return job;
    if (job.status !== 'published') move(job, 'needs_reconciliation', 'YouTube outcome is uncertain. Reconcile the saved session/video; do not start another upload.');
    return job;
  });
}
async function verifyCurrent(state: StudioState, job: Job): Promise<void> {
  if (state.paused) throw new Error('Publishing is paused.');
  const snapshot = job.snapshot; const draft = state.drafts.find(item => item.id === job.draftId); const account = state.accounts.find(item => item.id === job.accountId);
  if (!snapshot || !draft || !account || job.platform !== 'youtube' || job.provider !== 'native' || account.platform !== 'youtube' || account.provider !== 'native' || account.status !== 'connected' || account.integrationId !== expectedYouTubeChannelId) throw new Error('Use a connected native YouTube account with the verified channel ID and an immutable job snapshot.');
  await verifyDraftApproval(draft);
  if (draft.approvedHash !== snapshot.draft.approvedHash || draft.revision !== snapshot.draft.revision || account.id !== snapshot.account.id || account.label !== snapshot.account.label || account.integrationId !== snapshot.account.integrationId || account.provider !== snapshot.account.provider || account.platform !== snapshot.account.platform) throw new Error('Draft/media approval or account target changed; schedule the reviewed version.');
}
export async function uploadYouTubeJob(id: string, settingsInput: Settings, input: Transport = {}): Promise<Job> {
  const settings = youtubeSettingsSchema.parse(settingsInput);
  if (await loadJournal(id)) throw new Error('A durable YouTube upload journal already exists. Reconcile it; this command never starts a second upload.');
  const bundle = await exportJob(id);
  await verifyCurrent(await readState(), bundle.job);
  const files = bundle.variant.mediaPaths.filter(path => /\.mp4$/i.test(path));
  if (files.length !== 1 || !files[0]) throw new Error('Attach exactly one reviewed MP4 to this YouTube variant.');
  const info = await stat(files[0]);
  if (!info.isFile() || info.size <= 32 || info.size > 512 * 1024 * 1024) throw new Error('The stage-one uploader supports a non-empty MP4 up to 512 MiB.');
  const video = await readFile(files[0]);
  if (video.toString('ascii', 4, 8) !== 'ftyp') throw new Error('The approved media is not an MP4 container.');
  const mediaHash = createHash('sha256').update(video).digest('hex');
  const description = `${bundle.variant.text}\n\n${settings.descriptionDisclosure}\n\nSources:\n${bundle.draft.brief.sources.map(source => source.url).join('\n')}`;
  if (!bundle.variant.title.trim() || [...bundle.variant.title].length > 100 || /[<>]/.test(bundle.variant.title) || Buffer.byteLength(description) > 5000 || bundle.variant.tags.join(',').length > 400) throw new Error('Reviewed YouTube metadata exceeds supported API limits; edit and approve the draft before uploading.');
  const io = await boundTransport(input);
  await verifyYouTubeChannel(io);
  const journal: Journal = { version: 1, jobId: id, channelId: expectedYouTubeChannelId, approvedHash: bundle.job.approvedHash, mediaHash, mediaBytes: video.length, metadata: { snippet: { title: bundle.variant.title, description, tags: bundle.variant.tags, categoryId: settings.categoryId, defaultLanguage: settings.defaultLanguage }, status: { privacyStatus: settings.privacyStatus, selfDeclaredMadeForKids: settings.selfDeclaredMadeForKids, containsSyntheticMedia: settings.containsSyntheticMedia } }, phase: 'starting', sessionUrl: null, videoId: null, at: now() };
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  await mutateState(async state => {
    const job = findJob(state, id); if (!['scheduled', 'awaiting_operator'].includes(job.status)) throw new Error('This YouTube job is already submitted or cannot be uploaded.');
    await verifyCurrent(state, job);
    if (createHash('sha256').update(await readFile(files[0] ?? '')).digest('hex') !== mediaHash) throw new Error('Video changed while preflight was running; review and approve again.');
    job.status = 'submitting'; job.attempts++; job.submissionOwner = owner; job.submissionStartedAt = now(); job.error = null;
    job.history.push({ at: now(), status: 'submitting', message: 'Official YouTube upload claimed; durable reconciliation is required after any unknown outcome.' });
  });
  try {
    await saveJournal(journal);
    const started = await call('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(video.length), 'X-Upload-Content-Type': 'video/mp4' }, body: JSON.stringify(journal.metadata) }, io);
    if (!started.ok) throw new Error(`YouTube session request returned HTTP ${started.status}.`);
    const location = started.headers.get('Location'); if (!location) throw new Error('YouTube session response had no location.');
    journal.sessionUrl = validatedSession(location); journal.phase = 'session_ready'; await saveJournal(journal);
    await mutateState(async state => { const job = findJob(state, id); if (job.status !== 'submitting' || job.submissionOwner !== owner || !journalMatchesJob(job, journal)) throw new Error('YouTube submission ownership or snapshot changed before media upload.'); await verifyCurrent(state, job); job.submissionStartedAt = now(); });
    journal.phase = 'sending'; await saveJournal(journal);
    const uploaded = await call(journal.sessionUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length), 'Content-Range': `bytes 0-${video.length - 1}/${video.length}` }, body: new Uint8Array(video).buffer }, io);
    if (![200, 201].includes(uploaded.status)) throw new Error(`YouTube upload returned HTTP ${uploaded.status}.`);
    const reply = await parsed(uploaded, z.object({ id: videoIdSchema })); journal.videoId = reply.id; journal.phase = 'uploaded'; await saveJournal(journal);
    await mutateState(state => {
      const job = findJob(state, id);
      if (job.status !== 'submitting' || job.submissionOwner !== owner || !journalMatchesJob(job, journal)) throw new Error('YouTube submission ownership or snapshot changed after media upload; reconcile the saved video.');
      job.providerPostId = reply.id; move(job, 'queued', 'YouTube returned a video ID; processing and public visibility are not yet verified.');
    });
    return reconcileYouTubeJob(id, io);
  } catch {
    // Never issue another session POST, even when the first response was lost.
    await failUnknown(id, undefined, owner);
    throw new Error('YouTube upload did not finish with verified publication. The job is preserved for reconciliation; no automatic retry was performed.');
  }
}
export async function reconcileYouTubeJob(id: string, input: Transport = {}): Promise<Job> {
  const journal = await loadJournal(id); if (!journal) throw new Error('No saved YouTube upload journal exists for this job.');
  const initial = findJob(await readState(), id);
  if (!journalMatchesJob(initial, journal) || !['submitting', 'queued', 'needs_reconciliation', 'published'].includes(initial.status)) throw new Error('YouTube reconciliation does not match this job snapshot.');
  if (liveSubmissionOwner(initial)) throw new Error('The YouTube submission owner is still running; wait for it to finish before reconciliation.');
  const fingerprint = jobFingerprint(initial);
  const io = await boundTransport(input);
  await verifyYouTubeChannel(io);
  if (!journal.videoId && journal.sessionUrl) {
    const probed = await call(validatedSession(journal.sessionUrl), { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${journal.mediaBytes}` } }, io);
    if ([200, 201].includes(probed.status)) { const reply = await parsed(probed, z.object({ id: videoIdSchema })); journal.videoId = reply.id; journal.phase = 'uploaded'; await saveJournal(journal); }
    else return failUnknown(id, fingerprint);
  }
  if (!journal.videoId) return failUnknown(id, fingerprint);
  const response = await call(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${journal.videoId}`, { method: 'GET' }, io);
  if (!response.ok) return failUnknown(id, fingerprint);
  const reply = await parsed(response, z.object({ items: z.array(z.object({ id: videoIdSchema, snippet: z.object({ channelId: z.string() }), status: z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']), uploadStatus: z.enum(['uploaded', 'processed', 'failed', 'rejected', 'deleted']) }), processingDetails: z.object({ processingStatus: z.enum(['processing', 'succeeded', 'failed', 'terminated']) }).optional() })) }));
  const video = reply.items[0];
  if (reply.items.length !== 1 || !video || video.id !== journal.videoId || video.snippet.channelId !== expectedYouTubeChannelId) return failUnknown(id, fingerprint);
  return mutateState(state => {
    const job = findJob(state, id);
    if (jobFingerprint(job) !== fingerprint || !journalMatchesJob(job, journal)) return job;
    job.providerPostId = video.id;
    if (['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus) || video.processingDetails?.processingStatus === 'failed') { move(job, 'needs_reconciliation', 'YouTube reported a rejected/failed/deleted video; inspect the existing video before any new upload.'); return job; }
    if (video.status.privacyStatus === 'public' && video.status.uploadStatus === 'processed' && video.processingDetails?.processingStatus !== 'processing') { job.remoteId = video.id; job.remoteUrl = `https://www.youtube.com/watch?v=${video.id}`; move(job, 'published', 'Official YouTube API readback confirmed matching channel, processed upload and public privacy. Viewer playback and geographic restrictions need separate acceptance.'); }
    else if (job.status === 'published' || (job.remoteId && job.remoteUrl)) move(job, 'needs_reconciliation', `Previously confirmed YouTube video now has API privacy ${video.status.privacyStatus} and upload status ${video.status.uploadStatus}; inspect its current visibility. The historical publication receipt is preserved.`);
    else move(job, 'queued', `YouTube video exists; API privacy is ${video.status.privacyStatus} and upload status is ${video.status.uploadStatus}. Public publication is not yet confirmed.`);
    return job;
  });
}
