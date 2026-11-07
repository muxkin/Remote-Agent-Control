import { isUtf8 } from 'node:buffer';

/** MIME is derived from bytes, never from an untrusted upload Content-Type. */
export function attachmentMime(name: string, data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return 'image/gif';
  const riff = data.subarray(0, 4).toString() === 'RIFF';
  if (riff && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (riff && data.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (data.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (data.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (
    data.subarray(0, 3).toString() === 'ID3' ||
    (data.length > 3 &&
      data[0] === 0xff &&
      (data[1] & 0xe0) === 0xe0 &&
      (data[1] & 0x06) !== 0 &&
      (data[2] & 0xf0) !== 0xf0)
  )
    return 'audio/mpeg';
  if (data.subarray(4, 8).toString() === 'ftyp' && /\.(m4a|mp4)$/i.test(name))
    return /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/mp4';
  if (
    data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    data.subarray(0, 4096).includes(Buffer.from('webm'))
  )
    return data.subarray(0, 4096).includes(Buffer.from('OpusHead')) &&
      !/V_VP[89]|V_AV1/.test(data.subarray(0, 4096).toString('latin1'))
      ? 'audio/webm'
      : 'video/webm';
  if (
    /\.(txt|md|csv|log|json|ya?ml|toml|py|tsx?|jsx?|sh|rs|c|cpp|h)$/i.test(name) &&
    !data.includes(0) &&
    isUtf8(data)
  )
    return 'text/plain; charset=utf-8';
  if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
