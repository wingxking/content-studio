import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { draftDirectory, readDraftRevision, writeDraftArtifacts } from '../src/core/artifacts.ts';
import type { Draft } from '../src/core/model.ts';

const originalEnv = { ...process.env };
let directory = '';
const draft: Draft = {
  id: randomUUID(), title: 'A sourced draft', body: 'Complete master content.', createdAt: new Date().toISOString(), revision: 1, approvedHash: null,
  brief: { topic: 'Practical topic', audience: 'Creators', angle: 'Useful sourced facts', sources: [{ title: 'Source', url: 'https://example.com/source', excerpt: 'A verified source fact.' }], platforms: ['x'] },
  variants: [{ platform: 'x', title: 'Adapted title', text: 'Complete adapted text.', tags: [], mediaPaths: [] }],
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'content-studio-artifact-recovery-'));
  process.env.STUDIO_DATA_DIR = directory;
});
afterEach(async () => { process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

test('an interrupted immutable snapshot is repaired and its original bytes are retained', async () => {
  const revision = join(draftDirectory(draft.id), 'revision-1');
  await mkdir(revision, { recursive: true });
  await writeFile(join(revision, 'content.json'), '{"title":"interrupted');
  await writeFile(join(revision, 'x.md'), '# Adapted');
  await writeDraftArtifacts(draft);
  assert.deepEqual(await readDraftRevision(draft.id, 1), draft);
  assert.match(await readFile(join(revision, 'x.md'), 'utf8'), /Complete adapted text/);
  const preserved = (await readdir(revision)).filter(name => name.includes('.incomplete-'));
  assert.equal(preserved.length, 2);
  assert.equal(await readFile(join(revision, preserved.find(name => name.startsWith('content.json'))!), 'utf8'), '{"title":"interrupted');
  assert.equal((await readdir(revision)).some(name => name.endsWith('.tmp')), false);
});

test('approving an unchanged revision preserves its first complete immutable snapshot', async () => {
  await writeDraftArtifacts(draft);
  const approved = { ...draft, approvedHash: 'new-owner-approval' };
  await writeDraftArtifacts(approved);
  assert.equal((await readDraftRevision(draft.id, 1)).approvedHash, null);
  assert.equal(JSON.parse(await readFile(join(draftDirectory(draft.id), 'content.json'), 'utf8')).approvedHash, approved.approvedHash);
  assert.equal((await readdir(join(draftDirectory(draft.id), 'revision-1'))).some(name => name.includes('.incomplete-')), false);
});

test('a complete conflicting snapshot is preserved and fails closed', async () => {
  await writeDraftArtifacts(draft);
  await assert.rejects(writeDraftArtifacts({ ...draft, body: 'Different content under the same revision.' }), /immutable draft snapshot differs/i);
  assert.deepEqual(await readDraftRevision(draft.id, 1), draft);
});
