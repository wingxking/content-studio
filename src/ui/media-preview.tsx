import { useQuery } from '@tanstack/react-query';
import { readMediaKind, type MediaKind } from '../client/media.ts';

export function MediaPreview({ reference, alt }: { reference: string; alt: string }) {
  const known: MediaKind | null = /\.(mp4|mov)$/iu.test(reference) ? 'video' : /\.(png|jpe?g|webp|gif)$/iu.test(reference) ? 'image' : null;
  const query = useQuery({ queryKey: ['media-preview', reference], queryFn: ({ signal }) => readMediaKind(reference, signal), enabled: !known, staleTime: Infinity, retry: false });
  const kind = known ?? query.data;
  const url = `/api/media?path=${encodeURIComponent(reference)}`;
  return kind === 'video' ? <video controls preload="metadata" src={url}/> : kind === 'image' ? <img alt={alt} src={url}/> : null;
}
