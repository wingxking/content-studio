import { z } from 'zod';

export const runtimeReleaseSchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
  builtAt: z.iso.datetime(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type RuntimeRelease = z.infer<typeof runtimeReleaseSchema>;
