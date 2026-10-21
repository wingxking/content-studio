import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { localfsDirectory } from './localfs.ts';
import { knowledgeIdsSchema, knowledgeLimits, knowledgeSnapshotSchema, knowledgeSourceSchema, type KnowledgeExcerpt, type KnowledgeMount, type KnowledgeSource } from './knowledge-model.ts';
export { knowledgeIdsSchema, knowledgeLimits, knowledgeExcerptSchema, knowledgeSourceSchema, type KnowledgeExcerpt, type KnowledgeMount, type KnowledgeSource } from './knowledge-model.ts';
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sourceIdentity = (name: string, digest: string, provenance: KnowledgeSource['provenance']): string => JSON.stringify([name, digest, provenance.kind, provenance.kind === 'mount' ? provenance.relativePath : '']);
const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;
function allowedPath(path: string): boolean {
  const pieces = path.split(/[\\/]/u);
  return !/[\u0000-\u001f\u007f]/u.test(path) && pieces.every(piece => piece && piece !== '..' && !piece.startsWith('.') && !/(?:^|[-_.])(secrets?|credentials?|cookies?|tokens?|passwords?|auth)(?:[-_.]|$)/iu.test(piece)) && ['.txt', '.md', '.json', '.csv'].includes(extname(path).toLowerCase());
}
export function inspectKnowledgeText(name: string, bytes: Buffer): string {
  if (name !== basename(name) || !allowedPath(name) || name.length > 200) throw new Error('Choose a non-sensitive .txt, .md, .json or .csv file. PDF support is pending.');
  if (!bytes.length || bytes.length > knowledgeLimits.fileBytes) throw new Error('Knowledge files must be non-empty and at most 2 MiB.');
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Knowledge files must contain valid UTF-8 text.'); }
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Binary or empty knowledge files are not accepted.');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?[^\s"']{12,}/iu.test(text)) throw new Error('This file appears to contain credentials. Remove private values before importing.');
  return text;
}
async function immutableFile(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try { await chmod(temporary, 0o400); try { await link(temporary, path); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; } const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  finally { await rm(temporary, { force: true }); }
}
async function managedJson(path: string, maximumBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await file.stat(); if (!info.isFile() || !info.size || info.size > maximumBytes) throw new Error('Knowledge manifest exceeds its supported size.'); return JSON.parse(await file.readFile('utf8')) as unknown; }
  finally { await file.close(); }
}
function excerptWindow(text: string, query: string): { excerpt: string; start: number; end: number } {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
  const lower = text.toLocaleLowerCase(); const hit = terms.map(term => lower.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, hit - 300); let end = Math.min(text.length, start + knowledgeLimits.excerptCharacters);
  if (start && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start++;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
  return { excerpt: text.slice(start, end), start, end };
}
export class KnowledgeStore {
  readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(root = join(localfsDirectory(), 'knowledge'), private readonly mountRoot = process.env.STUDIO_KNOWLEDGE_IMPORT_DIR) { this.root = resolve(root); }
  private async initialize(): Promise<void> { for (const name of ['objects', 'sources', 'snapshots']) await mkdir(join(this.root, name), { recursive: true, mode: 0o700 }); }
  private sourcePath(id: string): string { return join(this.root, 'sources', `${z.uuid().parse(id)}.json`); }
  async list(): Promise<KnowledgeSource[]> {
    await this.initialize(); const names = (await readdir(join(this.root, 'sources'))).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name));
    if (names.length > knowledgeLimits.files) throw new Error('Knowledge manifest count exceeds the supported limit.');
    const sources = await Promise.all(names.map(async name => knowledgeSourceSchema.parse(await managedJson(join(this.root, 'sources', name), 8192))));
    if (sources.reduce((sum, source) => sum + source.bytes, 0) > knowledgeLimits.totalBytes) throw new Error('Knowledge manifests exceed the 64 MiB library limit.');
    return sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<KnowledgeSource> { try { const source = knowledgeSourceSchema.parse(await managedJson(this.sourcePath(id), 8192)); if (source.id !== id) throw new Error('Knowledge manifest does not match its source revision.'); return source; } catch (error) { if (hasCode(error, 'ENOENT')) throw new Error('Knowledge source not found.'); throw error; } }
  async upload(name: string, bytes: Buffer, provenance: KnowledgeSource['provenance'] = { kind: 'upload' }): Promise<KnowledgeSource> {
    inspectKnowledgeText(name, bytes);
    const work = this.pending.then(async () => this.uploadUnlocked(name, bytes, provenance, await this.list()));
    this.pending = work.catch(() => undefined); return work;
  }
  private async uploadUnlocked(name: string, bytes: Buffer, provenance: KnowledgeSource['provenance'], sources: KnowledgeSource[]): Promise<KnowledgeSource> {
    const digest = sha256(bytes); const identity = sourceIdentity(name, digest, provenance);
    const existing = sources.find(source => sourceIdentity(source.name, source.sha256, source.provenance) === identity);
    if (existing) { await this.text(existing); return existing; }
    if (sources.length >= knowledgeLimits.files || sources.reduce((sum, source) => sum + source.bytes, 0) + bytes.length > knowledgeLimits.totalBytes) throw new Error('Knowledge library limit reached (500 revisions / 64 MiB).');
    const source = knowledgeSourceSchema.parse({ id: randomUUID(), name, sha256: digest, bytes: bytes.length, createdAt: new Date().toISOString(), provenance });
    const object = join(this.root, 'objects', `${digest}.txt`); await immutableFile(object, bytes);
    if (sha256(await readFile(object)) !== digest) throw new Error('Knowledge object integrity check failed.');
    await immutableFile(this.sourcePath(source.id), Buffer.from(JSON.stringify(source))); sources.push(source); return source;
  }
  private async text(source: KnowledgeSource): Promise<string> {
    const path = join(this.root, 'objects', `${source.sha256}.txt`); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await file.stat(); if (!info.isFile() || info.size !== source.bytes) throw new Error('Knowledge object integrity check failed.'); const bytes = await file.readFile(); if (sha256(bytes) !== source.sha256) throw new Error('Knowledge object integrity check failed.'); return inspectKnowledgeText(source.name, bytes); }
    finally { await file.close(); }
  }
  async excerpt(id: string, query = ''): Promise<KnowledgeExcerpt> { const source = await this.get(id); return { ...source, ...excerptWindow(await this.text(source), z.string().max(1000).parse(query)) }; }
  async readText(id: string): Promise<string> { return this.text(await this.get(id)); }
  async search(query: string): Promise<KnowledgeExcerpt[]> {
    const terms = z.string().trim().min(1).max(200).parse(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
    const hits: { source: KnowledgeSource; text: string; score: number }[] = [];
    for (const source of await this.list()) { const text = await this.text(source); const lower = `${source.name}\n${text}`.toLocaleLowerCase(); const score = terms.filter(term => lower.includes(term)).length; if (score) hits.push({ source, text, score }); }
    return hits.sort((a, b) => b.score - a.score).slice(0, 20).map(hit => ({ ...hit.source, ...excerptWindow(hit.text, query) }));
  }
  async mount(): Promise<KnowledgeMount> {
    if (!this.mountRoot) return { available: false, files: [], skipped: 0, truncated: false };
    const root = await realpath(this.mountRoot).catch(() => { throw new Error('The configured read-only knowledge mount is unavailable.'); });
    const files: KnowledgeMount['files'] = []; let skipped = 0; let entries = 0; let truncated = false;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 8) { skipped++; return; }
      const directory = join(root, relative); const info = await lstat(directory); const resolved = await realpath(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || resolved !== root && !resolved.startsWith(`${root}${sep}`)) { skipped++; return; }
      for await (const entry of await opendir(directory)) {
        if (++entries > knowledgeLimits.scanEntries || files.length >= knowledgeLimits.files) { truncated = true; return; }
        if (entry.name.startsWith('.') || /(?:secret|credential|cookie|token|password|^auth\b)/iu.test(entry.name)) { skipped++; continue; }
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { skipped++; continue; }
        if (entry.isDirectory()) { await walk(path, depth + 1); if (truncated) return; }
        else if (entry.isFile() && allowedPath(path)) { const info = await lstat(join(root, path)); if (info.isFile() && info.size > 0 && info.size <= knowledgeLimits.fileBytes) files.push({ path, bytes: info.size }); else skipped++; }
        else skipped++;
      }
    };
    await walk('', 0); return { available: true, files, skipped, truncated };
  }
  private async mountedBytes(relative: string): Promise<Buffer> {
    if (!this.mountRoot || relative.length > 500 || relative.startsWith('/') || relative.includes('\\') || !allowedPath(relative)) throw new Error('Choose a listed relative file from the configured knowledge mount.');
    const root = await realpath(this.mountRoot); const pieces = relative.split('/'); let path = root;
    for (const piece of pieces) { path = join(path, piece); if ((await lstat(path)).isSymbolicLink()) throw new Error('Knowledge import does not follow symbolic links.'); }
    const resolved = await realpath(path); if (!resolved.startsWith(`${root}${sep}`)) throw new Error('Knowledge source escapes its configured mount.');
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Linux verifies the opened descriptor as well as the path, closing parent-directory rename races.
      if (process.platform === 'linux' && !(await realpath(`/proc/self/fd/${file.fd}`)).startsWith(`${root}${sep}`)) throw new Error('Knowledge source escapes its configured mount.');
      const before = await file.stat(); if (!before.isFile() || !before.size || before.size > knowledgeLimits.fileBytes) throw new Error('Knowledge files must be regular files up to 2 MiB.');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      const after = await file.stat(); if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Knowledge source changed during import; retry explicitly.'); return bytes;
    } finally { await file.close(); }
  }
  async import(paths: string[]): Promise<KnowledgeSource[]> {
    const selected = z.array(z.string().min(1).max(500)).min(1).max(knowledgeLimits.importFiles).refine(values => new Set(values).size === values.length).parse(paths);
    const prepared: { path: string; bytes: Buffer }[] = []; for (const path of selected) { const bytes = await this.mountedBytes(path); inspectKnowledgeText(basename(path), bytes); prepared.push({ path, bytes }); }
    const work = this.pending.then(async () => {
      const current = await this.list(); const identities = new Set(current.map(source => sourceIdentity(source.name, source.sha256, source.provenance))); let addedCount = 0; let addedBytes = 0;
      for (const item of prepared) { const identity = sourceIdentity(basename(item.path), sha256(item.bytes), { kind: 'mount', relativePath: item.path }); if (!identities.has(identity)) { identities.add(identity); addedCount++; addedBytes += item.bytes.length; } }
      if (current.length + addedCount > knowledgeLimits.files || current.reduce((sum, source) => sum + source.bytes, 0) + addedBytes > knowledgeLimits.totalBytes) throw new Error('This batch exceeds the knowledge library limit (500 revisions / 64 MiB). No files were imported.');
      const imported: KnowledgeSource[] = [];
      try { for (const item of prepared) imported.push(await this.uploadUnlocked(basename(item.path), item.bytes, { kind: 'mount', relativePath: item.path }, current)); }
      catch { throw new Error(`Import interrupted after ${imported.length} of ${prepared.length} source snapshots completed. Refresh the library and retry the same selection; existing snapshots are reused.`); }
      return imported;
    });
    this.pending = work.catch(() => undefined); return work;
  }
  async snapshot(id: string, ids: string[], query: string): Promise<KnowledgeExcerpt[]> {
    const sourceIds = knowledgeIdsSchema.parse(ids); const path = join(this.root, 'snapshots', `${z.uuid().parse(id)}.json`);
    try { return await this.readSnapshot(id, sourceIds); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const excerpts = []; for (const sourceId of sourceIds) excerpts.push(await this.excerpt(sourceId, query.slice(0, 1000)));
    await immutableFile(path, Buffer.from(JSON.stringify({ id, sourceIds, excerpts }))); return this.readSnapshot(id, sourceIds);
  }
  async readSnapshot(id: string, expectedIds?: string[]): Promise<KnowledgeExcerpt[]> {
    const snapshot = knowledgeSnapshotSchema.parse(await managedJson(join(this.root, 'snapshots', `${z.uuid().parse(id)}.json`), 200 * 1024));
    if (snapshot.id !== id || expectedIds && JSON.stringify(snapshot.sourceIds) !== JSON.stringify(expectedIds) || snapshot.excerpts.length !== snapshot.sourceIds.length || snapshot.excerpts.some((excerpt, index) => excerpt.id !== snapshot.sourceIds[index])) throw new Error('Knowledge snapshot differs from its bound source revisions.');
    for (const excerpt of snapshot.excerpts) { const source = await this.get(excerpt.id); const text = await this.text(source); if (source.sha256 !== excerpt.sha256 || text.slice(excerpt.start, excerpt.end) !== excerpt.excerpt) throw new Error('Knowledge snapshot integrity check failed.'); }
    return snapshot.excerpts;
  }
}
export const knowledgeStore = (): KnowledgeStore => new KnowledgeStore();
