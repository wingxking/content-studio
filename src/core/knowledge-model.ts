import { z } from 'zod';

export const knowledgeLimits = { fileBytes: 2 * 1024 * 1024, files: 500, totalBytes: 64 * 1024 * 1024, importFiles: 50, selected: 8, excerptCharacters: 4000, scanEntries: 2000 } as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const knowledgeIdsSchema = z.array(z.uuid()).max(knowledgeLimits.selected).refine(ids => new Set(ids).size === ids.length, 'Knowledge sources must be unique.');
export const knowledgeSourceSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(200), sha256: hashSchema, bytes: z.number().int().positive().max(knowledgeLimits.fileBytes),
  createdAt: z.iso.datetime(), provenance: z.discriminatedUnion('kind', [z.object({ kind: z.literal('upload') }), z.object({ kind: z.literal('mount'), relativePath: z.string().min(1).max(500) })]),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export const knowledgeExcerptSchema = knowledgeSourceSchema.extend({ excerpt: z.string().min(1).max(knowledgeLimits.excerptCharacters), start: z.number().int().nonnegative(), end: z.number().int().positive() });
export type KnowledgeExcerpt = z.infer<typeof knowledgeExcerptSchema>;
export const knowledgeSnapshotSchema = z.object({ id: z.uuid(), sourceIds: knowledgeIdsSchema, excerpts: z.array(knowledgeExcerptSchema).max(knowledgeLimits.selected) });
export type KnowledgeMount = { available: boolean; files: { path: string; bytes: number }[]; skipped: number; truncated: boolean };
