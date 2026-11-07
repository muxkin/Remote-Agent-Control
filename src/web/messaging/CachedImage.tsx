import { useEffect, useState } from 'react';
import { loadMessagingMedia } from './media-cache';
import { useMessaging } from './context';
export function CachedImage({
  src,
  alt,
  className,
  onError,
}: {
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
}) {
  const { user } = useMessaging();
  const [url, setUrl] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setUrl('');
    if (user)
      void loadMessagingMedia(user.id, src, abort.signal)
        .then((file) => {
          if (!abort.signal.aborted) setUrl(file.url);
        })
        .catch(() => {
          if (!abort.signal.aborted) onError?.();
        });
    return () => abort.abort();
  }, [src, user?.id]);
  return url ? (
    <img src={url} alt={alt} className={className} decoding="async" onError={onError} />
  ) : (
    <span className={`im-image-skeleton ${className ?? ''}`} aria-label={`正在加载 ${alt}`} />
  );
}
