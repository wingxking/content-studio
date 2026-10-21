export type MediaKind = 'image' | 'video';

/** Stable references need MIME metadata; their IDs intentionally have no extension. */
export async function readMediaKind(reference: string, signal?: AbortSignal): Promise<MediaKind | null> {
  const response = await fetch(`/api/media?path=${encodeURIComponent(reference)}`, { method: 'HEAD', signal });
  if (!response.ok) throw new Error('Media preview is unavailable.');
  const mime = response.headers.get('content-type') ?? '';
  return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
}
