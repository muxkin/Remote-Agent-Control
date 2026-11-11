import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';

import { parsePairingLink } from '../shared/pairing-link';

export const PairScanner = tsxComponent(function PairScanner(initialProps: {
  onScan: (host: string, code: string) => void;
}) {
  const { onScan } = initialProps;

  const activeState = shallowRef(false);
  const setActive = writeRef(activeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const linkState = shallowRef('');
  const setLink = writeRef(linkState);
  const video = shallowRef<HTMLVideoElement | null>(null);
  const callback = { current: onScan };
  const watchActive = watchRender();
  return ({ onScan }) => {
    const active = activeState.value;
    const error = errorState.value;
    const link = linkState.value;

    callback.current = onScan;
    const accepted = (text: string) => {
      const { host, code } = parsePairingLink(text, location.origin);
      setError('');
      setActive(false);
      callback.current(host, code);
    };
    watchActive(() => {
      if (!active) return;
      let disposed = false,
        stream: MediaStream | undefined,
        frame = 0;
      const stop = () => {
        disposed = true;
        cancelAnimationFrame(frame);
        stream?.getTracks().forEach((t) => t.stop());
      };
      const hidden = () => {
        if (document.visibilityState === 'hidden') {
          stop();
          setActive(false);
        }
      };
      document.addEventListener('visibilitychange', hidden);
      void (async () => {
        if (!navigator.mediaDevices?.getUserMedia)
          throw Error('当前浏览器无法打开相机，请上传二维码图片或粘贴链接');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const target = video.value!;
        target.srcObject = stream;
        await target.play();
        const jsQR = (await import('jsqr')).default;
        const canvas = document.createElement('canvas'),
          context = canvas.getContext('2d', { willReadFrequently: true })!;
        let last = 0;
        const scan = (now: number) => {
          if (disposed) return;
          if (now - last > 180 && target.videoWidth) {
            last = now;
            canvas.width = Math.min(960, target.videoWidth);
            canvas.height = Math.round((target.videoHeight * canvas.width) / target.videoWidth);
            context.drawImage(target, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height),
              result = jsQR(pixels.data, pixels.width, pixels.height);
            if (result) {
              try {
                accepted(result.data);
                stop();
                return;
              } catch (e) {
                setError((e as Error).message);
              }
            }
          }
          frame = requestAnimationFrame(scan);
        };
        frame = requestAnimationFrame(scan);
      })().catch((e) => {
        if (!disposed) {
          const errors: Record<string, string> = {
            NotFoundError: '未检测到摄像头，可以识别二维码图片或粘贴配对链接',
            NotAllowedError: '请允许使用摄像头，或改用二维码图片配对',
            NotReadableError: '摄像头暂时无法使用，请关闭其他占用摄像头的应用',
          };
          setError(
            errors[e?.name] ??
              (e instanceof Error && /[\u4e00-\u9fff]/.test(e.message)
                ? e.message
                : '相机打开失败，请识别二维码图片或粘贴链接'),
          );
          setActive(false);
        }
        stop();
      });
      return () => {
        stop();
        document.removeEventListener('visibilitychange', hidden);
      };
    }, [active]);
    return (
      <div class="pair-scanner">
        {active ? (
          <>
            <video
              ref={video}
              playsinline
              muted
              aria-label="配对扫码相机"
              style={{ width: '100%', maxHeight: 320, borderRadius: 16, objectFit: 'cover' }}
            />
            <button type="button" class="secondary" onClick={() => setActive(false)}>
              关闭相机
            </button>
          </>
        ) : (
          <button
            type="button"
            class="primary"
            onClick={() => {
              setError('');
              setActive(true);
            }}
          >
            扫码添加电脑
          </button>
        )}
        <label class="secondary im-import-sticker">
          识别二维码图片
          <input
            type="file"
            accept="image/*"
            aria-label="识别配对二维码图片"
            onChange={(e) => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              (e.currentTarget as HTMLInputElement).value = '';
              if (!file) return;
              void (async () => {
                if (file.size > 10 * 1024 * 1024) throw Error('二维码图片不能超过 10 MB');
                const bitmap = await createImageBitmap(file);
                try {
                  const canvas = document.createElement('canvas');
                  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
                  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                  const context = canvas.getContext('2d')!;
                  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                  const pixels = context.getImageData(0, 0, canvas.width, canvas.height),
                    jsQR = (await import('jsqr')).default;
                  const result = jsQR(pixels.data, pixels.width, pixels.height);
                  if (!result) throw Error('图片中未找到二维码');
                  accepted(result.data);
                } finally {
                  bitmap.close();
                }
              })().catch((e) => setError(e.message));
            }}
          />
        </label>
        <details class="pair-manual">
          <summary>粘贴配对链接</summary>
          <label>
            配对链接
            <input
              value={link}
              onInput={(e) => setLink((e.currentTarget as HTMLInputElement).value)}
              autocomplete="off"
              spellcheck={false}
            />
          </label>
          <button
            type="button"
            class="secondary"
            onClick={() => {
              try {
                accepted(link);
                setLink('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            读取链接
          </button>
        </details>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };
});
