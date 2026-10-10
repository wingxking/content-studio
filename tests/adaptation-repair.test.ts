import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { adaptMaster } from '../src/core/generation-engine.ts';
import { xWeightedLength } from '../src/core/text-limits.ts';

const originalEnv = { ...process.env };
const sourceUrl = 'https://example.com/accessibility';
const brief = { topic: 'Accessible images', audience: 'Developers', angle: 'Image purpose', sources: [{ title: 'Source', url: sourceUrl, excerpt: 'Describe image purpose.' }], platforms: ['x' as const] };
const overlong = { platform: 'x', title: 'Image purpose', text: `${'中'.repeat(150)} AI-assisted. ${sourceUrl}`, tags: [], mediaPaths: [] };
const concise = { ...overlong, text: `描述图片用途。AI-assisted. ${sourceUrl}` };
let directory = ''; let imagePath = ''; let countPath = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-format-repair-')); imagePath = join(directory, 'reference.png'); countPath = join(directory, 'count');
  process.env.STUDIO_DATA_DIR = directory; process.env.CODEX_HOME = directory;
  await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model-test', display_name: 'Test', description: 'Fixture' }] }));
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
});
afterEach(async () => { process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });
async function configureCodex(results: unknown[]): Promise<void> {
  const binary = join(directory, 'codex');
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const prompt=fs.readFileSync(0,'utf8');const count=${JSON.stringify(countPath)};const attempt=fs.existsSync(count)?Number(fs.readFileSync(count,'utf8'))+1:1;fs.writeFileSync(count,String(attempt));fs.writeFileSync(${JSON.stringify(join(directory, 'prompt-'))}+attempt,prompt);const image=args[args.indexOf('--image')+1];if(!image||fs.readFileSync(image)[0]!==137||args[args.indexOf('--model')+1]!=='model-test')process.exit(2);const results=${JSON.stringify(results)};fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(results[Math.min(attempt-1,results.length-1)]));console.log(JSON.stringify({type:'turn.completed'}));\n`;
  await writeFile(binary, script); await chmod(binary, 0o700); process.env.CODEX_BIN = binary;
}
const allowed = (content: unknown) => ({ assessment: { status: 'allowed', reasons: ['Supplied source supports this content.'] }, content });
const options = () => ({ model: 'model-test', imagePaths: [imagePath] });

test('one format repair retains model/images/source/disclosure and revalidates official X weight', async () => {
  await configureCodex([allowed(overlong), allowed(concise)]);
  const result = await adaptMaster(brief, { title: 'Image purpose', body: 'Describe image purpose.' }, 'x', 'Write Chinese text.', options());
  assert.equal(await readFile(countPath, 'utf8'), '2'); assert.equal(result.text, concise.text); assert.ok(xWeightedLength(result.text) <= 280);
  const repairPrompt = await readFile(join(directory, 'prompt-2'), 'utf8');
  assert.match(repairPrompt, /FORMAT REPAIR ONLY/); assert.match(repairPrompt, /required AI\/commercial disclosures/); assert.ok(repairPrompt.includes(sourceUrl)); assert.match(repairPrompt, /Write Chinese text/);
});
test('a still-overlong repair terminates after two total calls', async () => {
  await configureCodex([allowed(overlong), allowed(overlong)]);
  await assert.rejects(adaptMaster(brief, { title: 'Image purpose', body: 'Describe image purpose.' }, 'x', 'Write Chinese text.', options()), /280 weighted/);
  assert.equal(await readFile(countPath, 'utf8'), '2');
});
test('uncertain or excluded assessments terminate without a format retry', async () => {
  for (const status of ['uncertain', 'excluded']) {
    await writeFile(countPath, '0'); await configureCodex([{ assessment: { status, reasons: ['Destination or source context is unresolved.'] }, content: null }]);
    await assert.rejects(adaptMaster(brief, { title: 'Image purpose', body: 'Describe image purpose.' }, 'x', 'Write Chinese text.', options()), /Destination or source context is unresolved/);
    assert.equal(await readFile(countPath, 'utf8'), '1');
  }
});
test('format repair cannot remove an existing source URL', async () => {
  await configureCodex([allowed(overlong), allowed({ ...concise, text: '描述图片用途。AI-assisted.' })]);
  await assert.rejects(adaptMaster(brief, { title: 'Image purpose', body: 'Describe image purpose.' }, 'x', 'Write Chinese text.', options()), /removed a cited source URL/);
  assert.equal(await readFile(countPath, 'utf8'), '2');
});
