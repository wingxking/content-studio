import { articleHtml, articleMarkdown } from './article-document.ts';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type Draft, draftSchema } from './model.ts';
import { dataDirectory, storageMode } from './store.ts';
import { dbRequest } from './database.ts';

export function draftDirectory(id: string): string { return join(dataDirectory(), 'content', z.uuid().parse(id)); }

async function completedTemporaryFile(path: string, content: string): Promise<string> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); }
  catch (error) { await rm(temp, { force: true }); throw error; }
  finally { await file.close(); }
  return temp;
}
export async function atomicFile(path: string, content: string): Promise<void> {
  const temp = await completedTemporaryFile(path, content);
  try { await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function immutableFile(path: string, name: string, content: string): Promise<void> {
  const temp = await completedTemporaryFile(path, content);
  try {
    try { await link(temp, path); return; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const existing = await readFile(path); const expected = Buffer.from(content);
    if (existing.equals(expected)) return;
    let interrupted = existing.length < expected.length && expected.subarray(0, existing.length).equals(existing);
    if (name === 'content.json') {
      const parsed = draftSchema.safeParse((() => { try { return JSON.parse(existing.toString('utf8')) as unknown; } catch { return null; } })());
      if (!parsed.success) interrupted = true;
      else {
        const incoming = draftSchema.parse(JSON.parse(content) as unknown);
        if (JSON.stringify({ ...parsed.data, approvedHash: null }) === JSON.stringify({ ...incoming, approvedHash: null })) return;
      }
    }
    if (!interrupted) throw new Error('An immutable draft snapshot differs from its database revision. Both versions are preserved; inspect the snapshot before continuing.');
    // Preserve interrupted bytes for inspection, then publish only a fully written replacement.
    await rename(path, `${path}.incomplete-${randomUUID()}`);
    await link(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function writeDraftArtifacts(draft: Draft, exporterVersion = 1): Promise<void> {
  z.number().int().min(1).max(1000).parse(exporterVersion);
  const root = draftDirectory(draft.id);
  const revisionRoot = join(root, `revision-${draft.revision}`);
  const revision = exporterVersion === 1 ? revisionRoot : join(revisionRoot, 'exports', `v${exporterVersion}`);
  await mkdir(revision, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {
    'master.md': `# ${draft.title}\n\n${draft.document ? articleMarkdown(draft.document) : draft.body}\n`,
    'content.json': `${JSON.stringify(draft, null, 2)}\n`,
    'sources.md': draft.brief.sources.map(source => `## ${source.title}\n\n${source.url}\n\n${source.excerpt}\n`).join('\n'),
  };
  if (draft.document) files['master.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>Article export</title></head><body>${articleHtml(draft.document)}</body></html>\n`;
  for (const variant of draft.variants) files[`${variant.platform}.md`] = `# ${variant.title}\n\n${variant.text}\n\n${variant.tags.map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ')}\n`;
  const lock = join(root, '.artifact-lock');
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 120000) await rm(lock, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error('Draft file export is busy; the database revision is preserved. Retry to repair its local files.');
      await delay(50);
    }
  }
  try {
    let latestRevision = 0;
    try { latestRevision = draftSchema.parse(JSON.parse(await readFile(join(root, 'content.json'), 'utf8'))).revision; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    for (const [name, text] of Object.entries(files)) {
      await immutableFile(join(revision, name), name, text);
      if (draft.revision >= latestRevision) await atomicFile(join(root, name), text);
    }
  } finally { await rm(lock, { recursive: true, force: true }); }

}

export async function readDraftRevision(id: string, revision: number): Promise<Draft> {
  z.uuid().parse(id);
  z.number().int().positive().parse(revision);
  if (storageMode() === 'supabase') {
    const rows = z.array(z.object({ content: draftSchema })).parse(await dbRequest(`studio_revisions?workspace_id=eq.${z.uuid().parse(process.env.STUDIO_WORKSPACE_ID)}&draft_id=eq.${id}&revision=eq.${revision}&limit=1`));
    if (rows[0]) return rows[0].content;
  }
  return draftSchema.parse(JSON.parse(await readFile(join(draftDirectory(id), `revision-${revision}`, 'content.json'), 'utf8')));
}
