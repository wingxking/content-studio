/** Modern clients keep pairing credentials out of URLs recorded by browser connection errors. */
export function studioPairingKey(url: URL, protocol: string | string[] | undefined): string | null {
  if (protocol === undefined && url.searchParams.size === 1 && url.searchParams.has('key')) return url.searchParams.get('key');
  if (url.searchParams.size || typeof protocol !== 'string' || !/^content-studio-key\.[A-Za-z0-9_-]{32,256}$/u.test(protocol)) return null;
  return protocol.slice('content-studio-key.'.length);
}
