import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const youtubeScopes = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'] as const;
const clientSchema = z.object({ installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth').or(z.literal('https://accounts.google.com/o/oauth2/v2/auth')).optional(), token_uri: z.literal('https://oauth2.googleapis.com/token').optional() }) });
type DesktopClient = z.infer<typeof clientSchema>['installed'];
const tokenReplySchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().int().positive(), scope: z.string().optional(), token_type: z.literal('Bearer') });
const tokenSchema = z.object({ version: z.literal(1), clientId: z.string(), accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number().int().positive(), scopes: z.array(z.string()) });

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
export async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('YouTube credential/journal files must be private regular files (mode 0600).');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}
function scopesFrom(value: string | undefined, fallback: readonly string[] = []): string[] {
  const granted = value?.split(/\s+/).filter(Boolean) ?? [...fallback];
  if (youtubeScopes.some(scope => !granted.includes(scope))) throw new Error('YouTube consent did not grant upload and read-only scopes.');
  return granted;
}
async function tokenRequest(parameters: URLSearchParams, fetcher: typeof fetch): Promise<z.infer<typeof tokenReplySchema>> {
  let response: Response;
  try { response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: parameters, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('Google token request failed. Credentials were not logged.'); }
  if (!response.ok) throw new Error(`Google token request rejected (HTTP ${response.status}); authorize again if consent expired or was revoked.`);
  try { return tokenReplySchema.parse(await response.json()); }
  catch { throw new Error('Google token response is invalid. Credentials were not logged.'); }
}
export async function authorizeDesktopYouTube(options: { clientFile: string; secretDirectory: string; onAuthorizationUrl: (url: string) => void | Promise<void>; fetcher?: typeof fetch; timeoutMs?: number; callbackPort?: number; listenHost?: '127.0.0.1' | '0.0.0.0' }): Promise<{ authorized: true }> {
  let client: DesktopClient;
  try { client = clientSchema.parse(JSON.parse(await readFile(options.clientFile, 'utf8'))).installed; }
  catch { throw new Error('Provide a downloaded Google OAuth Desktop client JSON file.'); }
  const fetcher = options.fetcher ?? fetch;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(z.number().int().min(0).max(65535).parse(options.callbackPort ?? 0), z.enum(['127.0.0.1', '0.0.0.0']).parse(options.listenHost ?? '127.0.0.1'), () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not start the OAuth loopback listener.'); }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Google authorization timed out; start a new authorization.')), options.timeoutMs ?? 300000);
    server.on('request', (request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      let url: URL;
      try { url = new URL(request.url ?? '/', redirectUri); }
      catch { response.writeHead(400); response.end('Invalid authorization callback.'); return; }
      const returnedState = url.searchParams.get('state') ?? '';
      const stateBuffer = Buffer.from(returnedState);
      if (request.method !== 'GET' || url.pathname !== '/oauth2/callback' || request.headers.host !== `127.0.0.1:${address.port}` || stateBuffer.length !== Buffer.byteLength(state) || !timingSafeEqual(stateBuffer, Buffer.from(state))) { response.writeHead(400); response.end('Invalid authorization callback.'); return; }
      if (url.searchParams.has('error')) { response.writeHead(400); response.end('Authorization was not granted. Return to Content Studio.'); reject(new Error('Google authorization was not granted.')); return; }
      const code = url.searchParams.get('code');
      if (!code || code.length > 10000) { response.writeHead(400); response.end('Missing authorization code.'); return; }
      response.writeHead(200); response.end('Authorization received. You can close this tab and return to Content Studio.'); resolve(code);
    });
  });
  // Attach a rejection handler before waiting for user/browser interaction.
  void codePromise.catch(() => undefined);
  try {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: youtubeScopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', login_hint: 'radarxai@gmail.com' }).toString();
    await options.onAuthorizationUrl(url.toString());
    const code = await codePromise;
    const reply = await tokenRequest(new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }), fetcher);
    if (!reply.refresh_token) throw new Error('No refresh token was returned; repeat authorization with consent.');
    const tokens = tokenSchema.parse({ version: 1, clientId: client.client_id, accessToken: reply.access_token, refreshToken: reply.refresh_token, expiresAt: Date.now() + reply.expires_in * 1000, scopes: scopesFrom(reply.scope) });
    await writePrivateJson(join(options.secretDirectory, 'client.json'), { installed: client });
    await writePrivateJson(join(options.secretDirectory, 'token.json'), tokens);
    return { authorized: true };
  } finally { if (timer) clearTimeout(timer); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
}
export function desktopYouTubeTokenProvider(secretDirectory: string, fetcher: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    let client: DesktopClient; let tokens: z.infer<typeof tokenSchema>;
    try { client = clientSchema.parse(await readPrivateJson(join(secretDirectory, 'client.json'))).installed; tokens = tokenSchema.parse(await readPrivateJson(join(secretDirectory, 'token.json'))); }
    catch { throw new Error('YouTube OAuth credentials are absent or invalid. Run youtube-auth with the Desktop client JSON.'); }
    if (tokens.clientId !== client.client_id) throw new Error('YouTube OAuth client changed; authorize this client again.');
    scopesFrom(undefined, tokens.scopes);
    if (tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
    const reply = await tokenRequest(new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, grant_type: 'refresh_token', refresh_token: tokens.refreshToken }), fetcher);
    const refreshed = tokenSchema.parse({ ...tokens, accessToken: reply.access_token, refreshToken: reply.refresh_token ?? tokens.refreshToken, expiresAt: Date.now() + reply.expires_in * 1000, scopes: scopesFrom(reply.scope, tokens.scopes) });
    await writePrivateJson(join(secretDirectory, 'token.json'), refreshed);
    return refreshed.accessToken;
  };
}
