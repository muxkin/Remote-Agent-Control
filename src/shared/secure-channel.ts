import { noise, type NoiseComponents } from '@libp2p/noise';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { AbstractMessageStream } from '@libp2p/utils';
import type { MessageStream, PrivateKey, Logger } from '@libp2p/interface';
import type { Uint8ArrayList } from 'uint8arraylist';

export const PROTOCOL_VERSION = 2;
export const MAX_PACKET = 16 * 1024 * 1024;
export type Lane = 'control' | 'bulk';
export interface Identity {
  peerId: string;
  privateKey: Uint8Array;
}
export async function createIdentity(): Promise<Identity> {
  const key = await generateKeyPair('Ed25519');
  return { peerId: peerIdFromPrivateKey(key).toString(), privateKey: privateKeyToProtobuf(key) };
}
export function identityKey(identity: Identity): PrivateKey {
  const key = privateKeyFromProtobuf(identity.privateKey);
  if (peerIdFromPrivateKey(key).toString() !== identity.peerId) throw Error('Invalid device identity');
  return key;
}
export function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
// Never let a deployment's DEBUG setting turn cryptographic traces into logs.
const silent = (() => {}) as unknown as Logger;
Object.assign(silent, { enabled: false, error: silent, trace: silent, newScope: () => silent });

/** A bounded, browser/Node byte-stream adapter. Only ciphertext reaches write(). */
export class CipherWire extends AbstractMessageStream {
  private draining = false;
  constructor(
    private write: (bytes: Uint8Array) => Promise<void>,
    private shutdown: () => void,
  ) {
    super({
      log: silent,
      maxMessageSize: 16 * 1024,
      maxReadBufferLength: 2 * 1024 * 1024,
      maxWriteBufferLength: 2 * 1024 * 1024,
    });
  }
  sendData(data: Uint8ArrayList) {
    if (this.draining) return { sentBytes: 0, canSendMore: false };
    const bytes = data.subarray().slice();
    this.draining = true;
    void this.write(bytes).then(
      () => {
        this.draining = false;
        this.onMuxerDrain();
      },
      () => this.abort(Error('Encrypted transport disconnected')),
    );
    return { sentBytes: bytes.length, canSendMore: false };
  }
  sendPause() {}
  sendResume() {}
  sendReset() {
    this.shutdown();
  }
  async close() {
    this.onTransportClosed();
    this.shutdown();
  }
}

export interface SecurePacket {
  message: Record<string, any>;
  bytes?: Uint8Array;
}
export class SecureChannel {
  private sendChain: Promise<void> = Promise.resolve();
  private listeners = new Set<(packet: SecurePacket) => void>();
  private backlog: SecurePacket[] = [];
  private pendingBytes = 0;
  private closed = false;
  private closeListeners = new Set<() => void>();
  private constructor(
    readonly remotePeer: string,
    private stream: MessageStream,
  ) {
    void this.read().catch(() => this.close());
  }
  static async open(
    wire: CipherWire,
    identity: Identity,
    outbound: boolean,
    lane: Lane,
    remotePeer?: string,
  ) {
    const key = identityKey(identity);
    const crypt = noise({ prologueBytes: new TextEncoder().encode(`codex-pocket/2/${lane}`) })({
      peerId: peerIdFromPrivateKey(key),
      privateKey: key,
      logger: { forComponent: () => silent },
      upgrader: { getStreamMuxers: () => new Map() } as unknown as NoiseComponents['upgrader'],
    });
    try {
      const options = {
        remotePeer: remotePeer ? peerIdFromString(remotePeer) : undefined,
        skipStreamMuxerNegotiation: true,
        signal: AbortSignal.timeout(10000),
      };
      const secured = await (outbound
        ? crypt.secureOutbound(wire, options)
        : crypt.secureInbound(wire, options));
      return new SecureChannel(secured.remotePeer.toString(), secured.connection);
    } catch {
      wire.abort(Error('Device identity or encrypted handshake rejected'));
      throw Error('设备身份验证失败或加密连接超时');
    }
  }
  onPacket(listener: (packet: SecurePacket) => void) {
    this.listeners.add(listener);
    const queued = this.backlog;
    this.backlog = [];
    for (const packet of queued) listener(packet);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    if (this.closed) queueMicrotask(listener);
    return () => this.closeListeners.delete(listener);
  }
  send(message: Record<string, any>, bytes?: Uint8Array): Promise<void> {
    const json = new TextEncoder().encode(JSON.stringify(message));
    const size = 4 + json.length + (bytes?.length ?? 0);
    if (size > MAX_PACKET || this.pendingBytes + size > 32 * 1024 * 1024 || this.closed)
      return Promise.reject(Error('Encrypted channel is unavailable or busy'));
    this.pendingBytes += size;
    const frame = new Uint8Array(size + 4);
    const header = new DataView(frame.buffer);
    header.setUint32(0, size);
    header.setUint32(4, json.length);
    frame.set(json, 8);
    if (bytes) frame.set(bytes, 8 + json.length);
    const sent = this.sendChain.then(async () => {
      for (let i = 0; i < frame.length; i += 16 * 1024) {
        if (this.closed) throw Error('Encrypted channel disconnected');
        if (!this.stream.send(frame.subarray(i, i + 16 * 1024)))
          await this.stream.onDrain({ signal: AbortSignal.timeout(30000) });
      }
    });
    this.sendChain = sent
      .catch(() => this.close())
      .finally(() => {
        this.pendingBytes -= size;
      });
    return sent;
  }
  private async read() {
    let prefix = new Uint8Array(4),
      prefixUsed = 0;
    let body: Uint8Array | undefined,
      used = 0;
    for await (const chunk of this.stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
      let offset = 0;
      while (offset < bytes.length) {
        if (!body) {
          const count = Math.min(4 - prefixUsed, bytes.length - offset);
          prefix.set(bytes.subarray(offset, offset + count), prefixUsed);
          offset += count;
          prefixUsed += count;
          if (prefixUsed !== 4) continue;
          const size = new DataView(prefix.buffer).getUint32(0);
          if (size < 6 || size > MAX_PACKET) throw Error('Invalid packet length');
          body = new Uint8Array(size);
          used = 0;
          prefixUsed = 0;
        }
        const count = Math.min(body.length - used, bytes.length - offset);
        body.set(bytes.subarray(offset, offset + count), used);
        offset += count;
        used += count;
        if (used !== body.length) continue;
        const jsonLength = new DataView(body.buffer).getUint32(0);
        if (jsonLength < 2 || jsonLength > body.length - 4) throw Error('Invalid envelope');
        const message = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(4, 4 + jsonLength)),
        );
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw Error('Invalid envelope');
        const packet = {
          message,
          ...(body.length > 4 + jsonLength ? { bytes: body.slice(4 + jsonLength) } : {}),
        };
        body = undefined;
        if (!this.listeners.size) {
          if (this.backlog.length >= 4) throw Error('Unconsumed encrypted stream');
          this.backlog.push(packet);
        } else for (const listener of this.listeners) listener(packet);
      }
    }
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stream.abort(Error('Device channel closed'));
    for (const listener of this.closeListeners) listener();
    this.listeners.clear();
    this.backlog = [];
  }
}
