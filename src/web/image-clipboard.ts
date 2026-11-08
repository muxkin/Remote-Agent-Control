/** Start the clipboard write during the click gesture, before fetching/decoding the original. */
export function copyImage(source: string | (() => Promise<Blob>)): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    return Promise.reject(Error('此浏览器不支持复制图片，请在图片上右键复制，或下载保存。'));
  const png = (async () => {
    const blob = typeof source === 'function' ? await source() : await imageBlob(source);
    if (blob.type === 'image/png') return blob;
    const image = await createImageBitmap(blob);
    try {
      if (image.width * image.height > 64_000_000) throw Error('图片过大，请下载原图。');
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw Error('无法读取图片，请下载原图。');
      context.drawImage(image, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(Error('图片转换失败'))), 'image/png'),
      );
    } finally {
      image.close();
    }
  })();
  // Also observe the source promise if clipboard permission is denied before it finishes.
  void png.catch(() => {});
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export async function imageBlob(url: string): Promise<Blob> {
  // Decrypted attachments already live in same-origin blob URLs. Read their pixels
  // via img-src, not a fetch that would unnecessarily need blob: in connect-src.
  if (url.startsWith('blob:')) {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > 64_000_000) throw Error('图片过大，请下载原图。');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw Error('无法读取图片，请下载原图。');
    context.drawImage(image, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(Error('图片转换失败'))), 'image/png'),
    );
  }
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw Error('原图读取失败，请重新加载后再复制。');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw Error('此附件不是可复制的图片。');
  return blob;
}
