import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { briefSchema, generatedSchema, type Brief, type Generated } from './model.ts';
import { buildArticlePrompt } from './content-prompts.ts';

const generationEnvelopeSchema = z.strictObject({
  assessment: z.strictObject({
    status: z.enum(['allowed', 'excluded', 'uncertain']),
    reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  }),
  content: generatedSchema.nullable(),
});

const bundledBinary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export async function codexExecutable(): Promise<string> {
  if (process.env.CODEX_BIN) {
    const binary = resolve(process.env.CODEX_BIN);
    await access(binary, constants.X_OK).catch(() => { throw new Error('CODEX_BIN must point to an executable Codex CLI binary.'); });
    return binary;
  }
  try { await access(bundledBinary, constants.X_OK); return bundledBinary; }
  catch {
    for (const directory of (process.env.PATH ?? '').split(':')) {
      const candidate = join(directory, 'codex');
      try { await access(candidate, constants.X_OK); return candidate; }
      catch { continue; }
    }
  }
  throw new Error('Codex CLI is unavailable. Install Codex or set CODEX_BIN to the real executable, then sign in locally.');
}
function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CODEX_HOME'];
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}
async function runCodex(binary: string, directory: string, schemaPath: string, resultPath: string, prompt: string): Promise<void> {
  const timeoutInput = Number(process.env.CODEX_TIMEOUT_MS ?? 240000);
  if (!Number.isFinite(timeoutInput) || timeoutInput < 1000 || timeoutInput > 600000) throw new Error('CODEX_TIMEOUT_MS must be between 1000 and 600000.');
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(binary, ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--output-schema', schemaPath, '-o', resultPath, '-'], { cwd: directory, env: childEnvironment(), stdio: ['pipe', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let errorBytes = 0;
    let terminalError: Error | null = null;
    const stop = (message: string): void => {
      terminalError ??= new Error(message);
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('Codex generation timed out. Check local Codex sign-in and network, then retry generation.'), timeoutInput);
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 2000000) stop('Codex exceeded its output limit. Retry with a shorter brief.'); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start Codex. Verify CODEX_BIN points to a working binary.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (terminalError) reject(terminalError);
      else if (code !== 0) reject(new Error(`Codex exited with code ${code ?? 'unknown'}. Run the configured Codex CLI directly to verify sign-in and network; raw logs are withheld from the web UI.`));
      else resolveRun();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
  });
}
export async function generateContent(input: Brief): Promise<Generated> {
  const brief = briefSchema.parse(input);
  if (new Set(brief.platforms).size !== brief.platforms.length) throw new Error('Requested platforms must be unique.');
  const binary = await codexExecutable();
  const directory = await mkdtemp(join(tmpdir(), 'content-studio-codex-'));
  try {
    const schemaPath = join(directory, 'output-schema.json');
    const resultPath = join(directory, 'result.json');
    await writeFile(schemaPath, JSON.stringify(z.toJSONSchema(generationEnvelopeSchema)), { mode: 0o600 });
    await runCodex(binary, directory, schemaPath, resultPath, buildArticlePrompt(brief));
    const info = await stat(resultPath).catch(() => { throw new Error('Codex completed without an output artifact. Verify structured-output support in this CLI version.'); });
    if (info.size > 2000000) throw new Error('Generated artifact exceeded the 2 MB limit.');
    let envelope: z.infer<typeof generationEnvelopeSchema>;
    try { envelope = generationEnvelopeSchema.parse(JSON.parse(await readFile(resultPath, 'utf8'))); }
    catch { throw new Error('Codex output failed the editorial assessment or content schema. No draft was saved; retry generation with a clearer brief.'); }
    if (envelope.assessment.status !== 'allowed') throw new Error(`Editorial assessment is ${envelope.assessment.status}. No draft was saved; choose a clearly permitted, supported topic.`);
    if (envelope.content === null) throw new Error('Allowed editorial assessment omitted content. No draft was saved.');
    const generated = envelope.content;
    const platforms = generated.variants.map(variant => variant.platform);
    if (platforms.length !== brief.platforms.length || brief.platforms.some((platform, index) => platforms[index] !== platform)) throw new Error('Codex did not return exactly one variant per requested platform in the requested order. No draft was saved.');
    if (generated.variants.some(variant => variant.mediaPaths.length > 0)) throw new Error('Codex attempted to invent media assets. No draft was saved.');
    return generated;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
