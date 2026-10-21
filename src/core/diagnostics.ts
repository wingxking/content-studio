import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDirectory } from "./store.ts";
import { diagnosticSchema, diagnosticQuerySchema, type Diagnostic, type DiagnosticInput } from "../contracts/diagnostics.ts";

const filePattern = /^events-[0-9a-f-]{36}-(?:(\d{13})-)?\d+\.ndjson$/u;
const defaultMaxBytes = 32 * 1024 * 1024;
const fileBytes = 1024 * 1024;
const retentionDays = 14;
/** Only fixed enums, numbers and UUIDs enter storage. Never accept free-form error, body or URL fields. */
export function diagnosticRecord(input: unknown, at = new Date().toISOString()): Diagnostic {
  return diagnosticSchema.parse({ ...(input && typeof input === "object" ? input : {}), id: randomUUID(), at });
}
export function createDiagnosticStore(directory: string, options: { maxBytes?: number; segmentBytes?: number; now?: () => number } = {}) {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const segmentBytes = options.segmentBytes ?? fileBytes;
  const clock = options.now ?? Date.now;
  const processId = randomUUID(); let segment = 0; let bytes = 0; let segmentStarted = clock(); let pending = Promise.resolve(); let queued = 0;
  async function files() {
    const names = await readdir(directory).catch((error: unknown) => { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; });
    const entries = await Promise.all(names.filter(name => filePattern.test(name)).map(async name => {
      const info = await lstat(join(directory, name)).catch(() => null);
      return info?.isFile() && !info.isSymbolicLink() ? { name, size: info.size, at: info.mtimeMs, started: Number(filePattern.exec(name)?.[1] ?? info.mtimeMs) } : null;
    }));
    return entries.filter(item => item !== null).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  }
  async function prune() {
    let total = 0;
    for (const file of await files()) {
      total += file.size;
      if (clock() - file.started > retentionDays * 86400000 || total > maxBytes) await unlink(join(directory, file.name)).catch(() => undefined);
    }
  }
  async function append(input: DiagnosticInput): Promise<Diagnostic | null> {
    const record = diagnosticRecord(input, new Date(clock()).toISOString());
    if (queued >= 1000) return null;
    queued++;
    const write = pending.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(record)}\n`;
      if (bytes + Buffer.byteLength(line) > segmentBytes || clock() - segmentStarted >= 86400000) { segment++; bytes = 0; segmentStarted = clock(); }
      const file = await open(join(directory, `events-${processId}-${segmentStarted}-${segment}.ndjson`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { await file.write(line); } finally { await file.close(); }
      bytes += Buffer.byteLength(line);
      await prune();
    });
    pending = write.catch(() => undefined);
    try { await write; return record; } finally { queued--; }
  }
  async function query(value: unknown = {}) {
    const input = diagnosticQuerySchema.parse(value);
    const cursor = input.cursor ? z.object({ at: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))) : null;
    let invalidLines = 0; let unreadableFiles = 0; let totalRead = 0;
    const items: Diagnostic[] = [];
    for (const file of await files()) {
      if (clock() - file.started > retentionDays * 86400000) continue;
      if (file.size > segmentBytes + 4096 || (totalRead += file.size) > maxBytes) { unreadableFiles++; continue; }
      try {
        const handle = await open(join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        let content: string;
        try { content = await handle.readFile("utf8"); } finally { await handle.close(); }
        for (const line of content.split("\n").filter(Boolean)) {
          let record: Diagnostic;
          try { record = diagnosticSchema.parse(JSON.parse(line)); } catch { invalidLines++; continue; }
          if (clock() - Date.parse(record.at) > retentionDays * 86400000) continue;
          if (cursor && (record.at > cursor.at || record.at === cursor.at && record.id >= cursor.id)) continue;
          if (input.level && record.level !== input.level || input.service && record.service !== input.service || input.jobId && record.jobId !== input.jobId || input.requestId && record.requestId !== input.requestId) continue;
          items.push(record);
        }
      } catch { unreadableFiles++; }
    }
    items.sort((a,b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const selected = items.slice(0,input.limit); const last = selected.at(-1);
    return { items: selected, nextCursor: items.length > input.limit && last ? Buffer.from(JSON.stringify({at:last.at,id:last.id})).toString("base64url") : null, invalidLines, unreadableFiles, retentionDays, maxBytes };
  }
  return { append, query };
}
let cached: { directory: string; store: ReturnType<typeof createDiagnosticStore> } | undefined;
export function diagnosticStore() {
  const workspace = z.uuid().safeParse(process.env.STUDIO_WORKSPACE_ID);
  const directory = join(dataDirectory(), "diagnostics", workspace.success ? workspace.data : "unconfigured");
  if (cached?.directory !== directory) cached = { directory, store: createDiagnosticStore(directory) };
  return cached.store;
}
export async function logDiagnostic(input: DiagnosticInput): Promise<void> {
  try { const record = await diagnosticStore().append(input); if (record) process.stdout.write(`${JSON.stringify(record)}\n`); }
  catch { process.stderr.write('{"level":"warn","event":"diagnostics.unavailable"}\n'); }
}
