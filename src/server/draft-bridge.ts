import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { draftExecutorHelloSchema, draftExecutorPlatforms, draftExecutorSaveSchema, draftJournalConfirmationSchema } from '../contracts/draft-executor.ts';
import { readDraftBridgeConfig, type DraftBridgeConfig } from '../core/draft-bridge-config.ts';
import { createCompanionChannel } from './companion-channel.ts';
import { studioPairingKey } from './studio-pairing.ts';

// These three reviewed upstream adapters only create drafts. No platform API is implemented here.
export const draftBridgePlatforms = draftExecutorPlatforms;
const platformSchema = z.enum(draftBridgePlatforms);
const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('checkAuth'), params: z.object({ platform: platformSchema }).strict() }).strict(),
  z.object({ method: z.literal('syncArticle'), params: draftExecutorSaveSchema }).strict(),
  z.object({ method: z.literal('studio.journal'), params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal('studio.confirmReceipt'), params: draftJournalConfirmationSchema }).strict(),
]);
type BridgeRequest = z.infer<typeof requestSchema>;
type ErrorCode = 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'INVALID_REQUEST' | 'NOT_CONNECTED' | 'BUSY' | 'UNKNOWN_OUTCOME' | 'EXTENSION_REJECTED' | 'EXTENSION_RESPONSE_INVALID' | 'UNAVAILABLE';
class BridgeError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number) { super(code); }
}
const maxBodyBytes = 24 * 1024 * 1024;
const messages: Record<ErrorCode, string> = {
  NOT_CONFIGURED: 'Configure the browser companion before connecting.', UNAUTHORIZED: 'Draft bridge authorization failed.', INVALID_REQUEST: 'The bridge request is invalid.', NOT_CONNECTED: 'The configured browser companion is not connected.', BUSY: 'A browser companion request is already running.', UNKNOWN_OUTCOME: 'The companion response was interrupted or timed out. Inspect the existing draft before retrying.', EXTENSION_REJECTED: 'The browser companion rejected the request. Verify its token and account login.', EXTENSION_RESPONSE_INVALID: 'The companion returned an invalid response. Inspect the existing draft before retrying.', UNAVAILABLE: 'The draft bridge is unavailable.',
};
type Session = { socket: WebSocket; configFingerprint: string; id: string; authenticated: boolean; features: string[]; heartbeatTimer: ReturnType<typeof setInterval> | null; heartbeatProbe: { id: string; timer: ReturnType<typeof setTimeout> } | null; heartbeatChecking: boolean };
type Pending = { sessionId: string; method: BridgeRequest['method']; resolve: (value: unknown) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout> };
export type DraftBridgeOptions = { configPath?: string; host?: string; wsPort?: number; httpPort?: number; readTimeoutMs?: number; writeTimeoutMs?: number; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number };
const heartbeatResultSchema = draftExecutorHelloSchema;

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function fingerprint(config: DraftBridgeConfig): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += bytes.length; if (length > maxBodyBytes) throw new BridgeError('INVALID_REQUEST', 413); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new BridgeError('INVALID_REQUEST', 400); }
}
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('Draft bridge listener failed.')); return; } resolve(address.port); }); });
}
function stop(server: Server): Promise<void> { return new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }

export function createDraftBridge(options: DraftBridgeOptions = {}): { start: () => Promise<{ wsPort: number; httpPort: number }>; close: () => Promise<void> } {
  let session: Session | null = null;
  let upgrading = false;
  let closing = false;
  const pending = new Map<string, Pending>();
  const failPending = (sessionId: string, code: ErrorCode) => { for (const [id, item] of pending) if (item.sessionId === sessionId) { clearTimeout(item.timer); pending.delete(id); item.reject(new BridgeError(code, 502)); } };
  const clearSession = (value: Session) => {
    if (value.heartbeatTimer) clearInterval(value.heartbeatTimer);
    if (value.heartbeatProbe) clearTimeout(value.heartbeatProbe.timer);
    value.heartbeatTimer = null; value.heartbeatProbe = null; value.authenticated = false;
    if (session?.id === value.id) session = null;
    failPending(value.id, 'UNKNOWN_OUTCOME');
  };
  const disconnect = (value: Session) => { clearSession(value); value.socket.terminate(); };
  const currentConfig = async (): Promise<DraftBridgeConfig> => {
    let config: DraftBridgeConfig | null;
    try { config = await readDraftBridgeConfig(options.configPath); }
    catch (error) { if (session) disconnect(session); throw error; }
    if (!config && session) disconnect(session);
    if (!config) throw new BridgeError('NOT_CONFIGURED', 503);
    if (session && session.configFingerprint !== fingerprint(config)) disconnect(session);
    return config;
  };
  // Authenticate the restored executor and its draft-only protocol without touching any platform.
  // Official upstream MCP alone is insufficient: it cannot enforce Studio job/account fences.
  const heartbeat = async (active: Session): Promise<void> => {
    if (closing || session?.id !== active.id || active.socket.readyState !== WebSocket.OPEN || active.heartbeatProbe || active.heartbeatChecking) return;
    active.heartbeatChecking = true;
    try {
      const config = await currentConfig();
      if (closing || session?.id !== active.id || active.socket.readyState !== WebSocket.OPEN || active.configFingerprint !== fingerprint(config)) return;
      const id = randomUUID();
      const timer = setTimeout(() => { if (active.heartbeatProbe?.id === id) disconnect(active); }, options.heartbeatTimeoutMs ?? 8000);
      timer.unref(); active.heartbeatProbe = { id, timer };
      active.socket.send(JSON.stringify({ id, method: 'studio.hello', token: config.extensionToken, params: {} }), error => { if (error && active.heartbeatProbe?.id === id) disconnect(active); });
    } catch { if (session?.id === active.id) disconnect(active); }
    finally { active.heartbeatChecking = false; }
  };
  const dispatch = (request: BridgeRequest, config: DraftBridgeConfig): Promise<unknown> => {
    const active = session;
    if (!active || !active.authenticated || active.socket.readyState !== WebSocket.OPEN) throw new BridgeError('NOT_CONNECTED', 503);
    if (pending.size) throw new BridgeError('BUSY', 409);
    const id = randomUUID();
    const write = request.method === 'syncArticle';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError(write ? 'UNKNOWN_OUTCOME' : 'UNAVAILABLE', 504)); }, write ? options.writeTimeoutMs ?? 12 * 60_000 : options.readTimeoutMs ?? 30_000);
      pending.set(id, { sessionId: active.id, method: request.method, resolve, reject, timer });
      active.socket.send(JSON.stringify({ id, method: request.method, token: config.extensionToken, params: request.params }), error => { if (error) { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); item.reject(new BridgeError('UNKNOWN_OUTCOME', 502)); } } });
    });
  };
  const httpServer = createServer((request, response) => {
    void (async () => {
      if (request.headers.origin !== undefined) throw new BridgeError('UNAUTHORIZED', 403);
      // Process health intentionally does not expose configuration or browser connectivity.
      if (request.method === 'GET' && request.url === '/healthz') { json(response, 200, { ok: true }); return; }
      const config = await currentConfig();
      if (!equalSecret(request.headers.authorization ?? '', `Bearer ${config.serviceKey}`)) throw new BridgeError('UNAUTHORIZED', 401);
      if (request.method === 'GET' && request.url === '/status') { json(response, 200, { configured: true, connected: session?.authenticated === true && session.socket.readyState === WebSocket.OPEN, features: session?.features ?? [] }); return; }
      if (request.method !== 'POST' || request.url !== '/request' || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new BridgeError('INVALID_REQUEST', 400);
      const parsed = requestSchema.safeParse(await body(request));
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 400);
      // Validate configuration again after reading the body so rotations cannot reuse an old session.
      const latest = await currentConfig();
      if (!equalSecret(request.headers.authorization ?? '', `Bearer ${latest.serviceKey}`)) throw new BridgeError('UNAUTHORIZED', 401);
      const result = await dispatch(parsed.data, latest); json(response, 200, { result });
    })().catch((error: unknown) => { const safe = error instanceof BridgeError ? error : new BridgeError('UNAVAILABLE', 503); json(response, safe.status, { error: { code: safe.code, message: messages[safe.code] } }); });
  });
  httpServer.requestTimeout = 15_000;
  const wsServer = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const companion = createCompanionChannel(currentConfig);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  wsServer.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (request.url?.split('?')[0] === '/ui/connect') { companion.upgrade(request,socket,head); return; }
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (closing) { reject(503); return; }
    if (upgrading) { reject(409); return; }
    upgrading = true;
    void (async () => {
      const config = await currentConfig();
      if (closing) { reject(503); return; }
      const url = new URL(request.url ?? '', 'http://bridge.invalid');
      if (request.headers.origin !== `chrome-extension://${config.extensionId}` || url.pathname !== '/connect' || !equalSecret(studioPairingKey(url,request.headers['sec-websocket-protocol']) ?? '', config.pairingKey)) { reject(403); return; }
      if (session && session.socket.readyState !== WebSocket.CLOSED) { reject(409); return; }
      wss.handleUpgrade(request, socket, head, client => {
        if (closing) { client.terminate(); return; }
        const active: Session = { socket: client, id: randomUUID(), configFingerprint: fingerprint(config), authenticated: false, features: [], heartbeatTimer: null, heartbeatProbe: null, heartbeatChecking: false }; session = active;
        client.on('close', () => clearSession(active));
        client.on('error', () => { clearSession(active); client.terminate(); });
        client.on('message', (bytes: RawData, isBinary: boolean) => {
          if (isBinary || session?.id !== active.id) { clearSession(active); client.terminate(); return; }
          const decoded: unknown = (() => { try { return JSON.parse(bytes.toString()) as unknown; } catch { return null; } })();
          const response = z.object({ id: z.string(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() }).strict().safeParse(decoded);
          if (!response.success) {
            const heartbeatReply = active.heartbeatProbe && typeof decoded === 'object' && decoded !== null && 'id' in decoded && decoded.id === active.heartbeatProbe.id;
            if (!heartbeatReply) failPending(active.id, 'EXTENSION_RESPONSE_INVALID');
            disconnect(active); return;
          }
          const parsed = response.data;
          if (active.heartbeatProbe?.id === parsed.id) {
            clearTimeout(active.heartbeatProbe.timer); active.heartbeatProbe = null;
            const hello = heartbeatResultSchema.safeParse(parsed.result);
            if (parsed.error || !hello.success) { disconnect(active); return; }
            active.authenticated = true;
            active.features = hello.data.features ?? [];
            if (!active.heartbeatTimer && !closing && session?.id === active.id) {
              active.heartbeatTimer = setInterval(() => { void heartbeat(active); }, options.heartbeatIntervalMs ?? 20_000);
              active.heartbeatTimer.unref();
            }
            return;
          }
          const item = pending.get(parsed.id);
          if (!item || item.sessionId !== active.id) return;
          clearTimeout(item.timer); pending.delete(parsed.id);
          if (parsed.error) { item.reject(new BridgeError(parsed.error.code === 401 || parsed.error.code === 403 ? 'EXTENSION_REJECTED' : 'UNKNOWN_OUTCOME', 502)); return; }
          if (!('result' in parsed)) { item.reject(new BridgeError('EXTENSION_RESPONSE_INVALID', 502)); return; }
          item.resolve(parsed.result);
        });
        void heartbeat(active);
      });
    })().catch(() => reject(503)).finally(() => { upgrading = false; });
  });
  return {
    async start() { const host = options.host ?? '0.0.0.0'; const wsPort = await listen(wsServer, options.wsPort ?? 9527, host); try { return { wsPort, httpPort: await listen(httpServer, options.httpPort ?? 8915, host) }; } catch (error) { await stop(wsServer); throw error; } },
    async close() { closing = true; companion.close(); if (session) disconnect(session); for (const client of wss.clients) client.terminate(); await Promise.all([stop(httpServer), stop(wsServer)]); wss.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = createDraftBridge();
  try { await bridge.start(); process.stdout.write('Draft bridge started.\n'); }
  catch { process.stderr.write('Draft bridge could not start.\n'); process.exitCode = 1; }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void bridge.close(); });
}
