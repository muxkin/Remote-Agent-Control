import { CipherWire, SecureChannel, type Identity, type Lane } from '../shared/secure-channel';
import { DeviceLink, type DeviceAuth } from '../shared/device-link';
import { apiCall, RpcError, type RpcCall } from '../shared/rpc';
import { applySync, checkpoint, contentVersion, type CachedThread } from '../shared/sync';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SyncStore, type PairedHost } from './sync-store';
import type { GatewayStatus, ServerEvent, ThreadView } from '../shared/types';

export class DeviceSession {
  readonly cache = new SyncStore();
  host?: PairedHost;
  status?: GatewayStatus;
  private identity?: Identity;
  private sessionId = crypto.randomUUID();
  private links = new Map<string, DeviceLink>();
  private opening = new Map<string, Promise<DeviceLink>>();
  private retry?: ReturnType<typeof setTimeout>;
  private peerRetry?: ReturnType<typeof setTimeout>;
  private watchRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private waking = false;
  private attempt = 0;
  private pc?: RTCPeerConnection;
  private candidates: RTCIceCandidateInit[] = [];
  private watchers = new Map<string, Set<(event: ServerEvent) => void>>();
  private views = new Map<string, CachedThread>();
  private events = new EventTarget();
  private running = false;
  private generation = 0;
  private listening = false;
  private processing = Promise.resolve();
  metrics = { relayBytes: 0, directBytes: 0, resyncs: 0, directAttempts: 0, directMillis: 0, fallback: '' };
  get direct() {
    return !!this.links.get('direct:control') && !this.links.get('direct:control')!.closed;
  }
  get online() {
    return this.direct || (!!this.links.get('relay:control') && !this.links.get('relay:control')!.closed);
  }
  get establishingDirect() {
    return !!this.pc && !this.direct;
  }
  onChange(fn: () => void) {
    this.events.addEventListener('change', fn);
    return () => this.events.removeEventListener('change', fn);
  }
  private changed() {
    this.events.dispatchEvent(new Event('change'));
  }
  private key(suffix: string) {
    return `${this.identity?.peerId}:${this.host?.hostId}:${suffix}`;
  }
  contentKey(suffix: string) {
    return this.key(suffix);
  }
  async init() {
    this.identity ??= await this.cache.identity();
    this.host ??= await this.cache.active();
    if (this.host && !this.running) {
      this.running = true;
      void this.connect();
    }
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('online', this.wake);
      document.addEventListener('visibilitychange', this.wake);
      window.addEventListener('pageshow', this.wake);
      setInterval(() => {
        if (this.online) {
          const link = this.link();
          void link.request('ping', {}, undefined, 10000).catch(() => link.close());
        }
      }, 20000);
    }
    return this.host;
  }
  private wake = () => {
    if (document.visibilityState === 'hidden' || this.waking) return;
    this.waking = true;
    void (async () => {
      await this.connect();
      // A surviving socket does not imply the phone received every foreground/background update.
      await this.resume();
      if (!this.direct) this.schedulePeer();
    })()
      .catch(() => {})
      .finally(() => {
        this.waking = false;
      });
  };
  async pair(hostId: string, code: string, name: string) {
    this.disconnect();
    this.identity ??= await this.cache.identity();
    const ticket = bytesToHex(sha256(new TextEncoder().encode(code)));
    const link = await this.openRelay(hostId, ticket, 'control', {
      type: 'pair',
      protocol: 2,
      sessionId: this.sessionId,
      code,
      name,
    });
    const ready = await link.ready;
    this.host = {
      hostId,
      name: ready.hostName,
      deviceId: ready.device.id,
      ticket: ready.ticket,
      phoneId: this.identity.peerId,
    };
    await this.cache.saveHost(this.host);
    this.running = true;
    this.attach(link, 'relay', 'control');
    this.schedulePeer();
    this.changed();
    void navigator.storage?.persist?.().catch(() => false);
    return this.host;
  }
  async select(host: PairedHost) {
    this.disconnect();
    this.host = host;
    await this.cache.saveHost(host);
    this.running = true;
    await this.connect();
  }
  private auth(): DeviceAuth {
    return { type: 'authenticate', protocol: 2, sessionId: this.sessionId };
  }
  async connect() {
    if (!this.running || !this.host) return;
    if (this.links.get('relay:control') && !this.links.get('relay:control')!.closed) return;
    try {
      await this.relay('control');
      this.attempt = 0;
      this.schedulePeer();
    } catch {
      this.metrics.fallback = '电脑离线或中继暂不可用';
    } finally {
      clearTimeout(this.retry);
      if (this.running && !this.links.get('relay:control'))
        this.retry = setTimeout(() => void this.connect(), Math.min(15000, 500 * 2 ** this.attempt++));
      this.changed();
    }
  }
  private async openRelay(hostId: string, ticket: string, lane: Lane, auth: DeviceAuth): Promise<DeviceLink> {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/connect`);
    ws.binaryType = 'arraybuffer';
    const wire = new CipherWire(
      async (bytes) => {
        const deadline = Date.now() + 10000;
        while (ws.bufferedAmount > 256 * 1024 && ws.readyState === WebSocket.OPEN && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 10));
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024)
          throw Error('Relay unavailable');
        ws.send(bytes as Uint8Array<ArrayBuffer>);
      },
      () => ws.close(),
    );
    let timer: ReturnType<typeof setTimeout>;
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        ws.close();
        reject(new RpcError('电脑未连接或配对已失效', 0));
      }, 10000);
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          wire.onData(new Uint8Array(e.data));
          return;
        }
        const msg = JSON.parse(e.data);
        if (msg.type === 'challenge') ws.send(JSON.stringify({ type: 'join', hostId, lane, ticket }));
        if (msg.type === 'joined') {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        wire.onTransportClosed();
        reject(new RpcError('电脑离线或配对失效', 0));
      };
      ws.onerror = () => ws.close();
    });
    return DeviceLink.authenticate(await SecureChannel.open(wire, this.identity!, true, lane, hostId), auth);
  }
  private async relay(lane: Lane) {
    const key = `relay:${lane}`,
      old = this.links.get(key);
    if (old && !old.closed) return old;
    if (this.opening.has(key)) return this.opening.get(key)!;
    const generation = this.generation;
    const promise = this.openRelay(this.host!.hostId, this.host!.ticket, lane, this.auth()).then((link) => {
      if (generation !== this.generation || !this.running) {
        link.close();
        throw Error('Device switched');
      }
      this.attach(link, 'relay', lane);
      return link;
    });
    this.opening.set(key, promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(key);
    }
  }
  private attach(link: DeviceLink, path: 'relay' | 'direct', lane: Lane) {
    const generation = this.generation;
    const key = `${path}:${lane}`;
    this.links.get(key)?.close();
    this.links.set(key, link);
    void link.ready.then((ready) => {
      if (generation !== this.generation) return;
      this.status = ready.status;
      this.changed();
    });
    link.onClose(() => {
      if (this.links.get(key) === link) this.links.delete(key);
      this.changed();
      if (lane === 'control') {
        void this.resume();
        if (path === 'direct') this.schedulePeer();
        else void this.connect();
      }
    });
    link.onEvent((event) => {
      this.processing = this.processing
        .then(() => (generation === this.generation ? this.receive(event) : undefined))
        .catch(() => {
          this.metrics.resyncs++;
          void this.resume();
        });
    });
    if (lane === 'control') void this.resume();
    this.changed();
  }
  private link(lane: Lane = 'control') {
    const link = this.links.get(`direct:${lane}`) ?? this.links.get(`relay:${lane}`);
    if (!link || link.closed) throw new RpcError('电脑未连接，当前显示缓存内容', 0);
    return link;
  }
  private async receive(event: Record<string, any>) {
    if (event.type === 'candidate') {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(event.candidate);
      else this.candidates.push(event.candidate);
    } else if (event.type === 'direct-closed') {
      this.closePeer();
      this.schedulePeer();
    } else if (event.type === 'sync') {
      const old =
        this.views.get(event.threadId) ??
        (await this.cache.get<CachedThread>(this.key(`thread:${event.threadId}`)));
      let next = old ?? null;
      for (const update of event.updates) {
        next = applySync(next, update);
        if (!next) break;
      }
      if (!next) {
        this.views.delete(event.threadId);
        this.metrics.resyncs++;
        await this.watchRemote(event.threadId, false);
        return;
      }
      this.views.set(event.threadId, next);
      this.cache.put(this.key(`thread:${event.threadId}`), next);
      for (const fn of this.watchers.get(event.threadId) ?? []) fn({ type: 'thread', thread: next.view });
    } else if (event.type === 'event') {
      if (event.event.type === 'status') {
        this.status = event.event.status;
        this.changed();
      }
      for (const listeners of this.watchers.values()) for (const fn of listeners) fn(event.event);
    }
  }
  subscribe(threadId: string, fn: (event: ServerEvent) => void) {
    const listeners = this.watchers.get(threadId) ?? new Set();
    listeners.add(fn);
    this.watchers.set(threadId, listeners);
    void (async () => {
      const cached =
        this.views.get(threadId) ?? (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`)));
      if (!listeners.has(fn)) return;
      if (cached) {
        this.views.set(threadId, cached);
        fn({
          type: 'thread',
          thread: {
            ...cached.view,
            synchronized: false,
            canSend: false,
            canInterrupt: false,
            reason: '本地缓存 · 正在确认最新状态',
          },
        });
      }
      await this.watchRemote(threadId);
    })().catch(() => {});
    return () => {
      listeners.delete(fn);
      if (!listeners.size) {
        this.watchers.delete(threadId);
        clearTimeout(this.watchRetries.get(threadId));
        this.watchRetries.delete(threadId);
        if (this.online)
          void this.link()
            .request('unwatch', { threadId })
            .catch(() => {});
      }
    };
  }
  private async watchRemote(threadId: string, useCache = true) {
    if (!this.online || !this.watchers.has(threadId)) return;
    clearTimeout(this.watchRetries.get(threadId));
    this.watchRetries.delete(threadId);
    const generation = this.generation;
    try {
      await this.link().request('watch', {
        threadId,
        known: useCache ? checkpoint(this.views.get(threadId) ?? null) : undefined,
      });
    } catch (error) {
      if (generation !== this.generation || !this.watchers.has(threadId)) return;
      if (error instanceof RpcError && error.status >= 400 && error.status < 500 && error.status !== 429)
        return;
      // Retry subscription confirmation even when the transport itself stays connected.
      this.watchRetries.set(
        threadId,
        setTimeout(() => {
          this.watchRetries.delete(threadId);
          void this.watchRemote(threadId, useCache);
        }, 1500),
      );
    }
  }
  private async resume() {
    for (const id of this.watchers.keys()) await this.watchRemote(id).catch(() => {});
  }
  private schedulePeer() {
    clearTimeout(this.peerRetry);
    if (!this.running || this.direct || this.pc || !this.online) return;
    this.peerRetry = setTimeout(() => void this.startPeer(), 500);
  }
  private closePeer() {
    this.pc?.close();
    this.pc = undefined;
    this.candidates = [];
    this.links.get('direct:control')?.close();
    this.links.get('direct:bulk')?.close();
  }
  private async startPeer() {
    const relay = this.links.get('relay:control');
    if (!relay || this.pc || !this.host) return;
    const ready = await relay.ready;
    if (!ready.p2p.enabled || !globalThis.RTCPeerConnection) return;
    const start = performance.now();
    this.metrics.directAttempts++;
    let pc: RTCPeerConnection;
    try {
      pc = this.pc = new RTCPeerConnection({
        iceServers: ready.p2p.stunUrls.length ? [{ urls: ready.p2p.stunUrls }] : [],
      });
    } catch {
      this.metrics.fallback = '当前浏览器无法建立直连';
      return;
    }
    let offered = false;
    const pending: RTCIceCandidateInit[] = [];
    const timer = setTimeout(() => {
      if (!this.direct && this.pc === pc) {
        this.closePeer();
        this.metrics.fallback = '直连超时，使用加密中继';
        this.peerRetry = setTimeout(() => this.schedulePeer(), 15000);
      }
    }, 15000);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (offered) void relay.request('candidate', { candidate: e.candidate.toJSON() }).catch(() => {});
      else pending.push(e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.pc === pc) {
        clearTimeout(timer);
        this.closePeer();
        this.peerRetry = setTimeout(() => this.schedulePeer(), 5000);
      }
    };
    for (const lane of ['control', 'bulk'] as const) {
      const dc = pc.createDataChannel(`pocket-${lane}-v2`, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 64 * 1024;
      const wire = new CipherWire(
        async (bytes) => {
          if (dc.bufferedAmount > 256 * 1024)
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => {
                dc.removeEventListener('bufferedamountlow', done);
                reject(Error('Direct backpressure'));
              }, 10000);
              const done = () => {
                clearTimeout(t);
                resolve();
              };
              dc.addEventListener('bufferedamountlow', done, { once: true });
            });
          dc.send(bytes as Uint8Array<ArrayBuffer>);
        },
        () => dc.close(),
      );
      dc.onmessage = (e) => wire.onData(new Uint8Array(e.data));
      dc.onclose = () => wire.onTransportClosed();
      dc.onopen = () => {
        void (async () => {
          const channel = await SecureChannel.open(wire, this.identity!, true, lane, this.host!.hostId);
          const link = await DeviceLink.authenticate(channel, this.auth());
          if (this.pc !== pc) {
            link.close();
            return;
          }
          this.attach(link, 'direct', lane);
          this.metrics.directMillis = performance.now() - start;
          clearTimeout(timer);
        })().catch(() => dc.close());
      };
    }
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const { value } = await relay.request('offer', { sdp: pc.localDescription!.sdp });
      offered = true;
      await pc.setRemoteDescription({ type: 'answer', sdp: value.sdp });
      for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
      for (const candidate of pending) await relay.request('candidate', { candidate });
    } catch {
      clearTimeout(timer);
      if (this.pc === pc) {
        this.closePeer();
        this.peerRetry = setTimeout(() => this.schedulePeer(), 15000);
      }
    }
  }
  async request(type: string, data: Record<string, unknown>, bytes?: Uint8Array, bulk = false) {
    if (!this.online) await this.connect();
    if (bulk && !this.links.get('direct:bulk')) await this.relay('bulk');
    const link = this.link(bulk ? 'bulk' : 'control');
    const result = await link.request(type, data, bytes, bulk ? 120000 : 30000);
    this.metrics[
      link === this.links.get(`direct:${bulk ? 'bulk' : 'control'}`) ? 'directBytes' : 'relayBytes'
    ] += (bytes?.length ?? 0) + (result.bytes?.length ?? 0) + JSON.stringify(result.value ?? null).length;
    return result;
  }
  async cachedThread(threadId: string): Promise<ThreadView | undefined> {
    await this.init();
    return (this.views.get(threadId) ?? (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`))))
      ?.view;
  }
  async cached<T>(path: string): Promise<T | undefined> {
    await this.init();
    const entry = await this.cache.get<{ value: T }>(this.key(`rpc:${contentVersion(apiCall(path))}`));
    return entry?.value;
  }
  async api<T>(path: string, init?: RequestInit): Promise<T> {
    await this.init();
    if (!this.host) throw new RpcError('请先扫码配对', 401);
    const call = apiCall(
      path,
      init?.method,
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    );
    if (call.method === 'session.read')
      return { device: { id: this.host.deviceId }, status: this.status } as T;
    const cacheable =
      (init?.method ?? 'GET') === 'GET' &&
      !['operation.read', 'operations.list', 'status.read'].includes(call.method);
    const key = this.key(`rpc:${contentVersion(call)}`),
      old = cacheable ? await this.cache.get<{ hash: string; value: T }>(key) : undefined;
    if (!this.online) {
      if (old) return old.value;
      await this.connect();
    }
    const { value } = await this.request('rpc', { call, knownHash: old?.hash });
    const result = value?.cacheHit && old ? old.value : value;
    if (cacheable) this.cache.put(key, { hash: contentVersion(result), value: result });
    return result;
  }
  async forget() {
    if (!this.host) return;
    await this.api('/logout', { method: 'POST', body: '{}' });
    const hostId = this.host.hostId,
      deviceId = this.host.deviceId;
    this.disconnect();
    await this.cache.forget(hostId);
    this.host = undefined;
    localStorage.removeItem(`pocket-pending:${deviceId}`);
    sessionStorage.removeItem(`pocket-drafts:${deviceId}`);
    localStorage.removeItem(`pocket-drafts:${deviceId}`);
    (await import('./file-client')).clearFileProviders();
  }
  disconnect() {
    this.running = false;
    this.generation++;
    this.opening.clear();
    for (const timer of this.watchRetries.values()) clearTimeout(timer);
    this.watchRetries.clear();
    clearTimeout(this.retry);
    clearTimeout(this.peerRetry);
    this.closePeer();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.watchers.clear();
    this.views.clear();
    this.status = undefined;
    this.sessionId = crypto.randomUUID();
  }
}
export const deviceSession = new DeviceSession();
/** Compatibility bridge for existing UI components; all requests still use the fixed RPC contract. */
export async function remoteFetch(path: string, init?: RequestInit): Promise<Response> {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    const match = /^\/api\/threads\/([^/]+)\/media$/.exec(path);
    const data =
      match && typeof init?.body === 'string'
        ? await (await import('./file-client')).mediaContent(match[1], JSON.parse(init.body).path)
        : await deviceSession.api(path, init);
    return Response.json(data);
  } catch (error) {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return Response.json(
      { error: error instanceof Error ? error.message : '请求失败' },
      { status: error instanceof RpcError && error.status >= 400 ? error.status : 503 },
    );
  }
}
