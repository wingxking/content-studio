import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { codexExecutable } from './generator.ts';
import { dataDirectory, readState, storageMode } from './store.ts';

export async function doctor(): Promise<Record<string, unknown>> {
  let codexAvailable = false;
  let codexPath: string | null = null;
  try { codexPath = await codexExecutable(); codexAvailable = true; } catch { /* Report availability without invoking generation. */ }
  let stateReadable = false;
  let localWritable = false;
  let storage: string = 'invalid';
  let stateError: string | null = null;
  let paused: boolean | null = null;
  let connectedAccounts = 0;
  try {
    storage = storageMode();
    if (storage === 'local') { await mkdir(dataDirectory(), { recursive: true, mode: 0o700 }); await access(dataDirectory(), constants.W_OK); localWritable = true; }
    const state = await readState(); stateReadable = true; paused = state.paused; connectedAccounts = state.accounts.filter(account => account.status === 'connected').length;
  } catch (error) { stateError = error instanceof Error ? error.message : 'Storage check failed.'; }
  return { stage: 1, requiredGoogleAccount: 'radarxai@gmail.com', codexAvailable, codexPath, codexAuthentication: 'Verify by running a real generation; executable availability does not prove sign-in.', storage, dataDirectory: dataDirectory(), stateReadable, localWritable, stateError, paused, connectedAccounts, postizConfigured: Boolean(process.env.POSTIZ_API_KEY), automaticTextPlatforms: ['x', 'linkedin'], sourceDiscovery: 'Official regional Google Trends RSS via explicit discover CLI; related news references require independent verification.', youtubePublishing: 'Explicit official API CLI with private Desktop OAuth; real authorization/upload acceptance is separate.', xPolicy: 'Trend-derived automated X publication is blocked; native handoff requires a genuine human.', videoGeneration: 'Local portrait video renderer is available with ffmpeg and macOS speech; render and attach actual media before scheduling video channels.', stageTwoGate: 'Complete stage-one live acceptance before starting stage two.' };
}
