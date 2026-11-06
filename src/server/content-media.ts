import { createHash } from 'node:crypto';
const cache = new WeakMap<object, string[]>();
export const inlineExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
export function itemMedia(item: any): string[] {
  if (!item || typeof item !== 'object') return [];
  const existing = cache.get(item);
  if (existing) return existing;
  const sources: string[] = [];
  // Desktop records view_image as its own item, separate from image generation
  // and MCP content blocks. Its path is already an explicit conversation image.
  if (item.type === 'imageView' && typeof item.path === 'string' && item.path.trim()) sources.push(item.path);
  if (item.type === 'imageGeneration') {
    const value = item.savedPath ?? item.src ?? item.result;
    if (typeof value === 'string' && value)
      sources.push(
        /^(data:|https?:|file:|[a-z]:[\\/]|\/)/i.test(value) ? value : `data:image/png;base64,${value}`,
      );
  }
  const visit = (value: any, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 100)) visit(entry, depth + 1);
      return;
    }
    if (
      ['image', 'audio', 'video'].includes(value.type) &&
      typeof value.data === 'string' &&
      Object.hasOwn(inlineExtensions, value.mimeType ?? '')
    )
      sources.push(`data:${value.mimeType};base64,${value.data}`);
    if (['image', 'audio', 'video'].includes(value.type) && typeof value.url === 'string')
      sources.push(value.url);
    if (['input_image', 'image_url'].includes(value.type)) {
      const url = typeof value.image_url === 'string' ? value.image_url : value.image_url?.url;
      if (typeof url === 'string') sources.push(url);
    }
    if (value.type === 'localImage' && typeof value.path === 'string') sources.push(value.path);
    if (
      value.type === 'resource_link' &&
      /^(image|video|audio)\//.test(value.mimeType ?? '') &&
      typeof value.uri === 'string'
    )
      sources.push(value.uri);
    for (const key of ['content', 'input', 'contentItems', 'result', 'output', 'toolOutput'])
      visit(value[key], depth + 1);
  };
  visit(item);
  const unique = [...new Set(sources)];
  cache.set(item, unique);
  return unique;
}
export function mediaReference(source: string): string {
  const extension = inlineExtensions[/^data:([^;]+);base64,/.exec(source)?.[1] ?? ''];
  return extension
    ? `pocket-inline:${createHash('sha256').update(source).digest('hex')}.${extension}`
    : source;
}
