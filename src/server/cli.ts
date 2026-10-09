import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { briefSchema, generatedSchema, platformSchema, accountSchema } from '../core/model.ts';
import { doctor } from '../core/doctor.ts';
import { generateContent } from '../core/generator.ts';
import { readState } from '../core/store.ts';
import { addAccount, approveDraft, cancelJob, confirmPublication, createDraft, exportJob, pausePublishing, reconcileJob, recordMetrics, replaceDraft, runDueJobs, scheduleJob, updateAccount, verifyDraftApproval } from '../core/pipeline.ts';
import { buildMedia } from '../core/media.ts';

const loadJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`Missing ${name}`); return value; };
const [command, first, second, third] = process.argv.slice(2);
try {
  let result: unknown;
  switch (command) {
    case 'doctor': result = await doctor(); break;
    case 'status': result = await readState(); break;
    case 'generate': {
      const brief = briefSchema.parse(await loadJson(required(first, 'brief JSON file')));
      result = await createDraft(brief, await generateContent(brief)); break;
    }
    case 'import': {
      const input = z.object({ brief: briefSchema, content: generatedSchema }).parse(await loadJson(required(first, 'content JSON file')));
      result = await createDraft(input.brief, input.content); break;
    }
    case 'approve': result = await approveDraft(required(first, 'draft ID')); break;
    case 'account': result = await addAccount(accountSchema.omit({ id: true }).parse(await loadJson(required(first, 'account JSON file')))); break;
    case 'account-update': result = await updateAccount(required(first, 'account ID'), accountSchema.omit({ id: true }).parse(await loadJson(required(second, 'account JSON file')))); break;
    case 'schedule': result = await scheduleJob(z.object({ draftId: z.uuid(), accountId: z.uuid(), scheduledAt: z.iso.datetime() }).parse(await loadJson(required(first, 'schedule JSON file')))); break;
    case 'run': result = await runDueJobs(); break;
    case 'pause': await pausePublishing(true); result = { paused: true }; break;
    case 'resume': await pausePublishing(false); result = { paused: false }; break;
    case 'cancel': result = await cancelJob(required(first, 'job ID')); break;
    case 'reconcile': result = await reconcileJob(required(first, 'job ID')); break;
    case 'receipt': result = await confirmPublication(required(first, 'job ID'), required(second, 'platform URL'), required(third, 'platform post ID')); break;
    case 'metrics': result = await recordMetrics(required(first, 'job ID'), z.object({ views: z.number().nonnegative().nullable(), likes: z.number().nonnegative().nullable(), comments: z.number().nonnegative().nullable(), clicks: z.number().nonnegative().nullable(), notes: z.string().max(2000) }).parse(await loadJson(required(second, 'metrics JSON file')))); break;
    case 'media': {
      const id = required(first, 'draft ID'); const platform = platformSchema.parse(second);
      const draft = (await readState()).drafts.find(item => item.id === id); if (!draft) throw new Error('Draft not found');
      await verifyDraftApproval(draft);
      const media = await buildMedia(draft, platform);
      try {
      const updated = await replaceDraft(id, { title: draft.title, body: draft.body, variants: draft.variants.map(variant => variant.platform === platform ? { ...variant, mediaPaths: media.files.filter(file => /\.(png|jpg|jpeg|mp4)$/i.test(file)) } : variant) }, draft.revision);
      result = { ...media, draft: updated, nextAction: 'Review assets and approve the updated revision before scheduling.' };
      } catch (error) { const firstFile=media.files[0]; const root=resolve(process.env.STUDIO_DATA_DIR ?? '.studio','media'); if(firstFile && dirname(firstFile).startsWith(`${root}${sep}`)) await rm(dirname(firstFile),{recursive:true,force:true}); throw error; }
      break;
    }
    case 'export': {
      const bundle = await exportJob(required(first, 'job ID')); const folder = resolve(required(second, 'output folder'));
      await mkdir(folder, { recursive: true });
      await writeFile(resolve(folder, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
      await writeFile(resolve(folder, 'post.md'), `# ${bundle.variant.title}\n\n${bundle.variant.text}\n\n${bundle.variant.tags.map(tag => `#${tag}`).join(' ')}\n\nOpen: ${bundle.nativeUrl}\n\nMedia:\n${bundle.variant.mediaPaths.join('\n')}\n`);
      result = { folder, status: bundle.job.status, nextAction: 'Use Chrome profile radarxai@gmail.com and record the verified platform ID and URL.' }; break;
    }
    default: result = { usage: ['doctor', 'status', 'generate <brief.json>', 'import <content.json>', 'approve <draft-id>', 'account <account.json>', 'media <draft-id> <platform>', 'schedule <schedule.json>', 'run', 'pause', 'resume', 'export <job-id> <folder>', 'receipt <job-id> <url> <remote-id>', 'reconcile <job-id>', 'metrics <job-id> <metrics.json>', 'cancel <job-id>'] };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`); process.exitCode = 1;
}
