import { tsxComponent } from '../tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from '../render-effects';

import { loadMessagingMedia } from './media-cache';
import { useMessaging } from './context';
export const CachedImage = tsxComponent(function CachedImage(_props: {
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
}) {
  const urlState = shallowRef('');
  const setUrl = writeRef(urlState);
  const watchUrl = watchRender();
  return ({ src, alt, className, onError }) => {
    const { user } = useMessaging();
    const url = urlState.value;
    watchUrl(() => {
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
      <img src={url} alt={alt} class={className} decoding="async" onError={onError} />
    ) : (
      <span class={`im-image-skeleton ${className ?? ''}`} aria-label={`正在加载 ${alt}`} />
    );
  };
});
