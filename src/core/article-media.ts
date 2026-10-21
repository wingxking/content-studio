import { z } from 'zod';
import { readDraftRevision } from './artifacts.ts';
import { draftSchema, generatedSchema, type Draft, type Generated, type Job } from './model.ts';
import { safeRuntimeError } from './runtime-overview.ts';

const referenceSchema = z.tuple([z.literal('studio-article-media'), z.uuid(), z.coerce.number().int().positive(), z.string().regex(/^[a-z][a-z0-9_]+$/u), z.coerce.number().int().min(0).max(19)]);

export function articleMediaReference(draft: Pick<Draft, 'id' | 'revision'>, platform: string, index: number): string {
  return `studio-article-media:${draft.id}:${draft.revision}:${platform}:${index}`;
}
export function publicArticle(draft: Draft): Draft {
  return draftSchema.parse({ ...draft, variants: draft.variants.map(variant => ({ ...variant,
    mediaPaths: variant.mediaPaths.map((path, index) => path.startsWith('studio-asset:') ? path : articleMediaReference(draft, variant.platform, index)),
  })) });
}
export async function originalArticleMedia(reference: string): Promise<string> {
  const [, id, revision, platform, index] = referenceSchema.parse(reference.split(':'));
  const draft = await readDraftRevision(id, revision);
  const path = draft.variants.find(variant => variant.platform === platform)?.mediaPaths[index];
  if (!path || path === reference || path.startsWith('studio-article-media:')) throw new Error('Article media reference is unavailable.');
  return path;
}
export async function restoreArticleMedia(content: Generated): Promise<Generated> {
  return generatedSchema.parse({ ...content, variants: await Promise.all(content.variants.map(async variant => ({ ...variant,
    mediaPaths: await Promise.all(variant.mediaPaths.map(path => path.startsWith('studio-article-media:') ? originalArticleMedia(path) : path)),
  }))) });
}
export function publicArticleJob(job: Job): Job {
  const summary = { ...job, error: safeRuntimeError(job.error), ...(job.verificationCheck ? { verificationCheck: { ...job.verificationCheck, lastError: safeRuntimeError(job.verificationCheck.lastError) } } : {}), history: job.history.map(event => ({ ...event,
    message: /\/(Users|data|auth|private|tmp|app|home)\/|bearer|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|cookie/iu.test(event.message) ? safeRuntimeError(event.message) ?? event.status : event.message,
  })) };
  if (!job.snapshot) return { ...summary, snapshot: null };
  if (!job.snapshot.draft) return { ...summary, snapshot: { ...job.snapshot, variant: { ...job.snapshot.variant, mediaPaths: [] } } };
  const draft = publicArticle(job.snapshot.draft);
  return { ...summary, snapshot: { ...job.snapshot, draft, variant: draft.variants.find(variant => variant.platform === job.platform) ?? { ...job.snapshot.variant, mediaPaths: [] } } };
}
