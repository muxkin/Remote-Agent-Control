import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64, unbase64 } from './secure-channel.js';
export const BLOCK_SIZE = 1024 * 1024;
export const MAX_FILE_SIZE = 256 * BLOCK_SIZE;
export const hashBytes = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export interface FileManifest {
  id: string;
  version: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  hashes: string[];
  key: string;
  nonce: string;
  storage: boolean;
}
export function fileSecret() {
  return {
    version: crypto.randomUUID(),
    key: base64(crypto.getRandomValues(new Uint8Array(32))),
    nonce: base64(crypto.getRandomValues(new Uint8Array(8))),
  };
}
export function blockLength(file: FileManifest, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= file.hashes.length) throw Error('Invalid file block');
  return Math.min(BLOCK_SIZE, file.size - index * BLOCK_SIZE);
}
async function cipher(file: FileManifest, index: number, bytes: Uint8Array, encrypt: boolean) {
  const length = blockLength(file, index),
    iv = new Uint8Array(12);
  iv.set(unbase64(file.nonce));
  new DataView(iv.buffer).setUint32(8, index);
  if (bytes.length !== length + (encrypt ? 0 : 16)) throw Error('File block truncated');
  const key = await crypto.subtle.importKey(
    'raw',
    unbase64(file.key) as Uint8Array<ArrayBuffer>,
    'AES-GCM',
    false,
    [encrypt ? 'encrypt' : 'decrypt'],
  );
  const result = new Uint8Array(
    await crypto.subtle[encrypt ? 'encrypt' : 'decrypt'](
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(JSON.stringify([file.id, file.version, index, length])),
      },
      key,
      bytes as Uint8Array<ArrayBuffer>,
    ),
  );
  if (!encrypt && hashBytes(result) !== file.hashes[index]) throw Error('File block checksum mismatch');
  return result;
}
export const encryptBlock = (file: FileManifest, index: number, bytes: Uint8Array) =>
  cipher(file, index, bytes, true);
export const decryptBlock = (file: FileManifest, index: number, bytes: Uint8Array) =>
  cipher(file, index, bytes, false);
export function fileRoute(size: number, direct: boolean, storage: boolean) {
  return direct ? 'direct' : size > 8 * BLOCK_SIZE && storage ? 'storage' : 'relay';
}
