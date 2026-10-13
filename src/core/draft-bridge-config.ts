import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const draftBridgeConfigSchema = z.object({
  extensionId: z.string().regex(/^[a-p]{32}$/),
  extensionToken: z.string().min(16).max(512),
  pairingKey: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  serviceKey: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
}).strict();
export type DraftBridgeConfig = z.infer<typeof draftBridgeConfigSchema>;
export const draftBridgeConfigPath = (): string => process.env.STUDIO_DRAFT_BRIDGE_CONFIG ?? '/data/draft-bridge/config.json';

export async function readDraftBridgeConfig(path = draftBridgeConfigPath()): Promise<DraftBridgeConfig | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw new Error('Draft bridge configuration is unavailable.'); }
  try { return draftBridgeConfigSchema.parse(JSON.parse(text) as unknown); }
  catch { throw new Error('Draft bridge configuration is invalid.'); }
}

export async function saveDraftBridgeConfig(value: DraftBridgeConfig, path = draftBridgeConfigPath()): Promise<void> {
  const parsed = draftBridgeConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error('Draft bridge configuration is invalid.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(parsed.data)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function draftBridgeConfigStatus(path = draftBridgeConfigPath()): Promise<{ configured: boolean; extensionId: string | null }> {
  const config = await readDraftBridgeConfig(path);
  return { configured: config !== null, extensionId: config?.extensionId ?? null };
}
