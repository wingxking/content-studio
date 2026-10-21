/** Content Studio ships its notices with the application; no upstream marketing feed. */
export interface RemoteBanner {
  id: string; title: string; description?: string;
  action?: { text: string; url: string }; icon?: string;
  style?: 'info' | 'promo' | 'warning'; dismissible?: boolean;
}
export async function fetchRemoteConfig(): Promise<void> {
  await chrome.storage.local.remove(['remoteBanners', 'remoteBanners_lastFetch']);
}
export const fetchConfigIfNeeded = fetchRemoteConfig;
export async function getActiveBanner(): Promise<RemoteBanner | null> { return null; }
export async function dismissBanner(_id: string): Promise<void> {}
