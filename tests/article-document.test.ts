import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articleDocumentSchema, articleMarkdown, articleText, documentFromText } from '../src/core/article-document.ts';
import { approveDraft, createDraft, replaceDraft, verifyDraftApproval } from '../src/core/pipeline.ts';

test('canonical article exports retain source references and reject executable links', () => {
  const document = articleDocumentSchema.parse({ schemaVersion: 1, content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Evidence' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Original source', marks: [{ type: 'link', attrs: { href: 'https://example.com/source' } }] }, { type: 'citation', attrs: { citationId: 'source-1' } }] }] } });
  assert.equal(articleText(document), 'Evidence\n\nOriginal source[source-1]');
  assert.equal(articleMarkdown(document), '## Evidence\n\n[Original source](https://example.com/source)\\[source-1]');
  const struck = documentFromText('Old claim'); struck.content.content![0]!.content![0]!.marks = [{ type: 'strike' }];
  assert.equal(articleMarkdown(struck), '~~Old claim~~');
  assert.equal(articleDocumentSchema.safeParse({ schemaVersion: 1, content: { type: 'doc', content: [{ type: 'text', text: 'unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] } }).success, false);
  assert.equal(articleDocumentSchema.safeParse({ schemaVersion: 1, content: { type: 'doc', content: [{ type: 'image', attrs: { src: '/private/secret.png' } }] } }).success, false);
});
test('rich formatting changes invalidate approval even when plain text remains identical', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rich-article-')); process.env.STUDIO_DATA_DIR = directory;
  try {
    const draft = await createDraft({ topic: 'Evidence', audience: 'Readers', angle: 'Useful explanation', sources: [{ title: 'Source', url: 'https://example.com', excerpt: 'Confirmed source excerpt.' }], platforms: ['reddit'] }, { title: 'Evidence', body: 'Original body.', document: documentFromText('Original body.'), variants: [{ platform: 'reddit', title: 'Evidence', text: 'Original body.', tags: [], mediaPaths: [] }] });
    const approved = await approveDraft(draft.id); await verifyDraftApproval(approved);
    const changed = structuredClone(approved); const text = changed.document?.content.content?.[0]?.content?.[0]; assert.ok(text); text.marks = [{ type: 'bold' }];
    await assert.rejects(verifyDraftApproval(changed), /changed after approval/);
    const saved = await replaceDraft(draft.id, changed, draft.revision);
    assert.equal(saved.body, approved.body); assert.equal(saved.approvedHash, null); assert.equal(saved.adaptationStatus, 'pending');
  } finally { delete process.env.STUDIO_DATA_DIR; await rm(directory, { recursive: true, force: true }); }
});

test('enabled rich editor marks all fit the canonical document contract', () => {
  const schema = getSchema([StarterKit.configure({ underline: false, link: { protocols: ['http', 'https'], openOnClick: false } })]);
  assert.equal(schema.marks.underline, undefined);
  for (const type of Object.keys(schema.marks)) assert(articleDocumentSchema.safeParse({ schemaVersion: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved', marks: [{ type, ...(type === 'link' ? { attrs: { href: 'https://example.com' } } : {}) }] }] }] } }).success, type);
});
