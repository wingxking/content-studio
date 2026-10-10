import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { buildArticlePrompt, buildDiscoveryPrompt, buildRefinementPrompt, buildVideoScriptPrompt, discoveryPromptInputSchema, platformEditorialGuidance, platformGuidancePrompt, videoScriptPromptInputSchema } from '../src/core/content-prompts.ts';
import { generateContent } from '../src/core/generator.ts';
import { generatedSchema, platformIds, type Brief, type Generated } from '../src/core/model.ts';
import { createDraft } from '../src/core/pipeline.ts';
import { readState } from '../src/core/store.ts';

const originalEnv = { ...process.env };
let directory = '';
const brief: Brief = { topic: 'Designing a software workflow', audience: 'Independent software creators', angle: 'Use documented features to reduce repetitive work', sources: [{ title: 'Software workflow documentation', url: 'https://example.org/workflow', excerpt: 'The software supports reusable workflow templates.' }], platforms: ['x'] };
const content: Generated = { title: 'A practical software workflow', body: 'Reusable templates reduce repeated setup. Source: https://example.org/workflow', variants: [{ platform: 'x', title: 'Reusable templates', text: 'Use a documented template to simplify repeated setup.', tags: [], mediaPaths: [] }] };
const allowed = (value: Generated = content) => ({ assessment: { status: 'allowed', reasons: ['A documented practical software topic.'] }, content: value });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'content-studio-prompt-test-'));
  process.env.STUDIO_DATA_DIR = directory;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
});
afterEach(async () => { process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

async function fakeCodex(output: unknown): Promise<void> {
  const executable = join(directory, 'fake-codex');
  const trace = join(directory, 'trace.json');
  const script = `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs'; const args = process.argv.slice(2); let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { prompt += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ schema: JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')), prompt })); writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(JSON.stringify(output))}); });\n`;
  await writeFile(executable, script, { mode: 0o700 });
  process.env.CODEX_BIN = executable;
}

test('allowed assessed content keeps the Generated API and saved state compatible', async () => {
  await fakeCodex(allowed());
  const generated = await generateContent(brief);
  assert.deepEqual(generated, content);
  assert.deepEqual(generatedSchema.parse(generated), content);
  const draft = await createDraft(brief, generated);
  assert.equal('assessment' in draft, false);
  assert.equal((await readState()).drafts[0]?.id, draft.id);
  const trace = JSON.parse(await readFile(join(directory, 'trace.json'), 'utf8')) as { schema: { properties: Record<string, unknown>; required: string[] } };
  assert.deepEqual(Object.keys(trace.schema.properties).sort(), ['assessment', 'content']);
  assert.deepEqual(trace.schema.required.sort(), ['assessment', 'content']);
});

for (const status of ['excluded', 'uncertain'] as const) {
  test(`${status} assessment never returns or saves a draft`, async () => {
    await fakeCodex({ assessment: { status, reasons: [status === 'excluded' ? 'The subject is excluded by editorial policy.' : 'The supplied evidence cannot resolve the actual subject.'] }, content: null });
    await assert.rejects(async () => createDraft(brief, await generateContent(brief)), new RegExp(`assessment is ${status}`));
    assert.deepEqual((await readState()).drafts, []);
  });
}

const malformedEnvelopes: { name: string; value: unknown }[] = [
  { name: 'legacy output with no assessment', value: content },
  { name: 'unknown assessment status', value: { assessment: { status: 'approved', reasons: ['Unknown status.'] }, content } },
  { name: 'missing assessment reasons', value: { assessment: { status: 'allowed' }, content } },
  { name: 'blank assessment reasons', value: { assessment: { status: 'allowed', reasons: [' '] }, content } },
  { name: 'malformed generated content', value: { assessment: { status: 'allowed', reasons: ['Software.'] }, content: { title: 'Incomplete' } } },
];
for (const { name, value } of malformedEnvelopes) {
  test(`${name} fails closed before draft persistence`, async () => {
    await fakeCodex(value);
    await assert.rejects(async () => createDraft(brief, await generateContent(brief)), /assessment or content schema/);
    assert.deepEqual((await readState()).drafts, []);
  });
}

test('allowed status without content cannot become a draft', async () => {
  await fakeCodex({ assessment: { status: 'allowed', reasons: ['Software.'] }, content: null });
  await assert.rejects(async () => createDraft(brief, await generateContent(brief)), /omitted content/);
  assert.deepEqual((await readState()).drafts, []);
});

test('excluded status cannot smuggle otherwise valid generated content through the gate', async () => {
  await fakeCodex({ assessment: { status: 'excluded', reasons: ['Sensitive subject.'] }, content });
  await assert.rejects(async () => createDraft(brief, await generateContent(brief)), /assessment is excluded/);
  assert.deepEqual((await readState()).drafts, []);
});

test('an allowed envelope must retain exact requested platform order', async () => {
  const mixedBrief: Brief = { ...brief, platforms: ['x', 'linkedin'] };
  const reordered: Generated = { ...content, variants: [{ ...content.variants[0]!, platform: 'linkedin' }, content.variants[0]!] };
  await fakeCodex(allowed(reordered));
  await assert.rejects(generateContent(mixedBrief), /requested order/);
  assert.deepEqual((await readState()).drafts, []);
});

test('all supported platforms have guidance and invalid or duplicate targets are rejected', () => {
  assert.deepEqual(Object.keys(platformEditorialGuidance).sort(), [...platformIds].sort());
  for (const platform of platformIds) assert.ok(platformEditorialGuidance[platform].length > 0);
  assert.throws(() => platformGuidancePrompt(['x', 'x']), /unique/);
  assert.throws(() => discoveryPromptInputSchema.parse({ platforms: ['unknown'], audience: 'Creators', instruction: 'Find practical questions', sources: [] }));
  assert.throws(() => buildArticlePrompt({ ...brief, platforms: ['x', 'x'] }), /unique/);
});

test('prompt export helpers do not create drafts or call Codex', async () => {
  process.env.CODEX_BIN = join(directory, 'does-not-exist');
  assert.equal(typeof buildArticlePrompt(brief), 'string');
  assert.equal(typeof buildDiscoveryPrompt(discoveryPromptInputSchema.parse({ platforms: ['x'], audience: 'Software creators', instruction: 'Find practical questions', sources: brief.sources })), 'string');
  assert.equal(typeof buildRefinementPrompt({ brief, content, target: 'master', instruction: 'Make the sourced explanation more concise' }), 'string');
  const videoBrief: Brief = { ...brief, platforms: ['youtube'] };
  assert.equal(typeof buildVideoScriptPrompt({ explicitlyRequested: true, brief: videoBrief, platform: 'youtube', article: content.body, instruction: 'Prepare a practical explanation' }), 'string');
  assert.deepEqual((await readState()).drafts, []);
});

test('refinement must target supplied content and independent video needs an explicit request', () => {
  assert.throws(() => buildRefinementPrompt({ brief, content, target: 'linkedin', instruction: 'Make the explanation clearer' }), /target is absent/);
  assert.throws(() => videoScriptPromptInputSchema.parse({ explicitlyRequested: false, brief, platform: 'youtube', article: content.body, instruction: 'Prepare a script' }));
  assert.throws(() => buildVideoScriptPrompt({ explicitlyRequested: true, brief, platform: 'youtube', article: content.body, instruction: 'Prepare a script' }), /requested in the brief/);
});


test('Reddit local drafting keeps explicit profile selection separate from subreddit rules and delivery access', () => {
  const guidance = platformGuidancePrompt(['reddit']);
  assert.match(guidance, /subreddit draft requires an explicitly identified subreddit and supplied current rules/);
  assert.match(guidance, /absent or unresolved subreddit rules make it uncertain/);
  assert.match(guidance, /personal-profile draft requires the user to explicitly select their own personal profile/);
  assert.match(guidance, /subreddit rules are not required for local drafting/);
  assert.match(guidance, /Reddit个人主页/);
  assert.match(guidance, /explicit destination choices, not a generic request/);
  assert.match(guidance, /never invent a handle or claim permission/);
  assert.match(guidance, /If neither destination is explicitly selected, assess the content as uncertain/);
  assert.match(guidance, /Automated access needs the required registered\/approved App/);
});
