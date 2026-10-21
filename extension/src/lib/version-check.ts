/** No Content Studio update feed is configured. Never install an upstream product as an update. */
export interface VersionInfo { version: string; downloadUrl: string; releaseNotes: string; releaseDate: string }
export interface UpdateCheckResult { hasUpdate: boolean; currentVersion: string; latestVersion?: string; info?: VersionInfo }
export async function checkForUpdates(_force = false): Promise<UpdateCheckResult> {
  await chrome.storage.local.remove(['version_update_info', 'version_last_check']);
  return { hasUpdate: false, currentVersion: chrome.runtime.getManifest().version };
}
export async function getCachedUpdateInfo(): Promise<UpdateCheckResult | null> { return null; }
export async function isUpdateDismissed(_version: string): Promise<boolean> { return false; }
export async function dismissUpdate(_version: string): Promise<void> {}
export async function clearDismissed(): Promise<void> { await chrome.storage.local.remove('version_dismissed'); }
