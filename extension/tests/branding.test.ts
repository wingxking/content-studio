import { afterEach, expect, it, vi } from 'vitest';
import { checkForUpdates, getCachedUpdateInfo } from '../src/lib/version-check';
import { fetchRemoteConfig, getActiveBanner } from '../src/lib/remote-config';

const removals: string[][] = [];
afterEach(() => { vi.unstubAllGlobals(); removals.length = 0; });
it('never fetches upstream updates/marketing or surfaces cached upstream links', async () => {
  const network = vi.fn(() => { throw new Error('Unexpected outbound request'); });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '2.0.9', name: 'Content Studio' }) },
    storage: { local: { remove: async (keys: string[]) => { removals.push(keys); }, get: async () => ({ version_update_info: { hasUpdate: true, info: { downloadUrl: 'https://untrusted.invalid/' } }, remoteBanners: [{ action: { url: 'https://untrusted.invalid/' } }] }) } },
  });
  expect(await checkForUpdates(true)).toEqual({ hasUpdate: false, currentVersion: '2.0.9' });
  expect(await getCachedUpdateInfo()).toBeNull();
  await fetchRemoteConfig(); expect(await getActiveBanner()).toBeNull();
  expect(network).not.toHaveBeenCalled();
  expect(removals.flat()).toContain('version_update_info');
  expect(removals.flat()).toContain('remoteBanners');
});
