import { browserId } from './browser-id';
import { DEFAULT_BACKEND, conversationKey } from '../shared/backends';
import { CipherWire, SecureChannel, type Identity, type Lane } from '../shared/secure-channel';
import { DeviceLink, type DeviceAuth } from '../shared/device-link';
import { apiCall, RpcError, type RpcCall } from '../shared/rpc';
import { applySync, checkpoint, contentVersion, type CachedThread } from '../shared/sync';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SyncStore, type PairedHost } from './sync-store';
import type { GatewayStatus, ServerEvent, ThreadView } from '../shared/types';
import type { AgentUsage } from '../../packages/adapter-sdk/src/usage';
import type { UsageSnapshot } from '../shared/usage';

export class DeviceSession {
  readonly cache = new SyncStore();
  backendId = DEFAULT_BACKEND;
  private statuses = new Map<string, GatewayStatus>();
  selectBackend(id: string) {
    this.backendId = id;
    this.status = this.statuses.get(id);
    this.changed();
  }
  host?: PairedHost;
  status?: GatewayStatus;
  private identity?: Identity;
  private sessionId = browserId();
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
  private usageWatchers = new Map<string, (snapshot: UsageSnapshot) => void>();
  private usageVersion = 0;
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
  get directBulk() {
    const link = this.links.get('direct:bulk');
    return !!link && !link.closed;
  }
  get online() {
    return this.direct || (!!this.links.get('relay:control') && !this.links.get('relay:control')!.closed);
  }
  get establishingDirect() {
    return !!this.pc && !this.directBulk;
  }
  onChange(fn: () => void) {
    this.events.addEventListener('change', fn);
    return () => this.events.removeEventListener('change', fn);
  }
  private changed() {
    this.events.dispatchEvent(new Event('change'));
  }
  private key(suffix: string, backendId = this.backendId) {
    return `${this.identity?.peerId}:${this.host?.hostId}:${backendId === DEFAULT_BACKEND ? '' : `backend:${backendId}:`}${suffix}`;
  }
  contentKey(suffix: string, backendId = this.backendId) {
    return this.key(suffix, backendId);
  }
  async init() {
    const generation = this.generation;
    const host = this.host ?? (await this.cache.active());
    const identity = this.identity ?? host?.identity ?? (await this.cache.identity());
    if (generation !== this.generation) return;
    this.host = host;
    this.identity = identity;
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
    const generation = this.generation;
    const identity = this.identity ?? (await this.cache.identity());
    if (generation !== this.generation) throw Error('账号或电脑已切换，请重新配对');
    this.identity = identity;
    const ticket = bytesToHex(sha256(new TextEncoder().encode(code)));
    const link = await this.openRelay(hostId, ticket, 'control', {
      type: 'pair',
      protocol: 2,
      sessionId: this.sessionId,
      code,
      name,
    });
    const ready = await link.ready;
    if (generation !== this.generation) {
      link.close();
      throw Error('账号或电脑已切换，请重新配对');
    }
    this.host = {
      hostId,
      name: ready.hostName,
      deviceId: ready.device.id,
      ticket: ready.ticket,
      phoneId: this.identity.peerId,
      identity: this.identity,
    };
    await this.cache.saveHost(this.host);
    if (generation !== this.generation) {
      link.close();
      throw Error('账号或电脑已切换');
    }
    this.running = true;
    this.attach(link, 'relay', 'control');
    this.schedulePeer();
    this.changed();
    void navigator.storage?.persist?.().catch(() => false);
    return this.host;
  }
  async select(host: PairedHost) {
    this.disconnect();
    const generation = this.generation;
    const identity = host.identity ?? (await this.cache.identity());
    if (generation !== this.generation) return;
    this.host = host;
    this.identity = identity;
    await this.cache.saveHost(host, false);
    if (generation !== this.generation) return;
    this.running = true;
    await this.connect();
  }
  resetAccount(scope: string) {
    this.disconnect();
    this.host = undefined;
    this.identity = undefined;
    this.status = undefined;
    this.statuses.clear();
    this.views.clear();
    this.watchers.clear();
    this.cache.scope = scope;
    void import('./file-client').then((module) => module.clearFileProviders());
    this.changed();
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
    } catch (error) {
      this.metrics.fallback = error instanceof Error ? error.message : '电脑离线或中继暂不可用';
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
        if (msg.type === 'challenge') {
          void (async () => {
            let resourceToken: string | undefined;
            if (msg.resources) {
              const response = await fetch('/api/im/resources/relay-ticket', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hostId, lane, ticket }),
              });
              const result = await response.json();
              if (!response.ok) throw new RpcError(result.error ?? '请先登录后使用中转', response.status);
              resourceToken = result.token;
            }
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: 'join',
                  hostId,
                  lane,
                  ticket,
                  ...(resourceToken ? { resourceToken } : {}),
                }),
              );
          })().catch((error) => {
            clearTimeout(timer);
            reject(error);
            ws.close();
          });
        }
        if (msg.type === 'joined') {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        wire.onTransportClosed();
        reject(new RpcError(event.reason || '电脑离线或配对失效', 0));
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
      if (generation !== this.generation || this.links.get(key) !== link || link.closed) return;
      this.statuses.set(DEFAULT_BACKEND, ready.status);
      if (this.backendId === DEFAULT_BACKEND) this.status = ready.status;
      this.changed();
    });
    link.onClose(() => {
      if (generation !== this.generation || this.links.get(key) !== link) return;
      this.links.delete(key);
      this.changed();
      if (lane === 'control') {
        void this.resume();
        if (path === 'direct') this.schedulePeer();
        else void this.connect();
      }
    });
    link.onEvent((event) => {
      if (generation !== this.generation || this.links.get(key) !== link) return;
      if (event.type === 'usage') {
        if (generation === this.generation && this.online && this.link() === link)
          this.usageWatchers.get(event.backendId)?.(event.snapshot);
        return;
      }
      const watchKey =
        event.type === 'sync'
          ? conversationKey(event.backendId ?? DEFAULT_BACKEND, event.threadId)
          : undefined;
      const listeners = watchKey ? this.watchers.get(watchKey) : undefined;
      // Do not queue large snapshots for chats that were already left.
      if (watchKey && !listeners) return;
      this.processing = this.processing
        .then(() => {
          if (generation !== this.generation || this.links.get(key) !== link) return;
          if (watchKey && this.watchers.get(watchKey) !== listeners) return;
          return this.receive(event);
        })
        .catch(() => {
          this.metrics.resyncs++;
          void this.resume();
        });
    });
    if (lane === 'control') void this.resume();
    this.changed();
  }
  private link(lane: Lane = 'control') {
    for (const path of ['direct', 'relay']) {
      const link = this.links.get(`${path}:${lane}`);
      if (link && !link.closed) return link;
    }
    throw new RpcError('电脑未连接，当前显示缓存内容', 0);
  }
  private async receive(event: Record<string, any>) {
    if (event.type === 'candidate') {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(event.candidate);
      else this.candidates.push(event.candidate);
    } else if (event.type === 'direct-closed') {
      this.closePeer();
      this.schedulePeer();
    } else if (event.type === 'sync') {
      const backendId = event.backendId ?? DEFAULT_BACKEND,
        key = conversationKey(backendId, event.threadId);
      const listeners = this.watchers.get(key),
        generation = this.generation;
      if (!listeners) return;
      const cacheKey = this.key(`thread:${event.threadId}`, backendId);
      const old = this.views.get(key) ?? (await this.cache.get<CachedThread>(cacheKey));
      if (generation !== this.generation || this.watchers.get(key) !== listeners) return;
      let next = old ?? null;
      for (const update of event.updates) {
        next = applySync(next, update);
        if (!next) break;
      }
      if (!next) {
        this.views.delete(key);
        this.metrics.resyncs++;
        await this.watchRemote(key, false);
        return;
      }
      this.views.set(key, next);
      this.cache.put(cacheKey, next);
      for (const fn of listeners) fn({ type: 'thread', thread: next.view });
    } else if (event.type === 'event') {
      const backendId = event.backendId ?? DEFAULT_BACKEND;
      if (event.event.type === 'status') {
        this.statuses.set(backendId, event.event.status);
        if (backendId === this.backendId) this.status = event.event.status;
        this.changed();
      }
      for (const [key, listeners] of this.watchers) {
        const [watchedBackend, watchedThread] = JSON.parse(key);
        if (watchedBackend === backendId && (!event.threadId || event.threadId === watchedThread))
          for (const fn of listeners) fn(event.event);
      }
    }
  }
  subscribe(threadId: string, fn: (event: ServerEvent) => void, backendId = this.backendId) {
    const key = conversationKey(backendId, threadId);
    const generation = this.generation;
    const listeners = this.watchers.get(key) ?? new Set();
    listeners.add(fn);
    this.watchers.set(key, listeners);
    void (async () => {
      const cached =
        this.views.get(key) ??
        (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`, backendId)));
      if (generation !== this.generation || this.watchers.get(key) !== listeners || !listeners.has(fn))
        return;
      if (cached) {
        this.views.set(key, cached);
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
      await this.watchRemote(key);
    })().catch(() => {});
    return () => {
      listeners.delete(fn);
      if (!listeners.size && this.watchers.get(key) === listeners) {
        this.watchers.delete(key);
        // SyncStore retains the history on disk and has its own bounded memory cache.
        this.views.delete(key);
        clearTimeout(this.watchRetries.get(key));
        this.watchRetries.delete(key);
        if (this.online)
          void this.link()
            .request('unwatch', { threadId, backendId })
            .catch(() => {});
      }
    };
  }
  private async watchRemote(key: string, useCache = true) {
    const [backendId, threadId] = JSON.parse(key) as [string, string];
    if (!this.online || !this.watchers.has(key)) return;
    clearTimeout(this.watchRetries.get(key));
    this.watchRetries.delete(key);
    const generation = this.generation;
    try {
      await this.link().request('watch', {
        threadId,
        backendId,
        known: useCache ? checkpoint(this.views.get(key) ?? null) : undefined,
      });
    } catch (error) {
      if (generation !== this.generation || !this.watchers.has(key)) return;
      for (const fn of this.watchers.get(key) ?? [])
        fn({ type: 'error', message: error instanceof Error ? error.message : '会话加载失败，请重试' });
      if (error instanceof RpcError && error.status >= 400 && error.status < 500 && error.status !== 429)
        return;
      // Retry subscription confirmation even when the transport itself stays connected.
      this.watchRetries.set(
        key,
        setTimeout(() => {
          this.watchRetries.delete(key);
          void this.watchRemote(key, useCache);
        }, 1500),
      );
    }
  }
  private async resume() {
    for (const id of this.watchers.keys()) await this.watchRemote(id).catch(() => {});
  }
  watchUsage(backendId: string, notify: (snapshot: UsageSnapshot) => void) {
    const generation = this.generation;
    let selected: DeviceLink | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const current = (link: DeviceLink) => !disposed && generation === this.generation && selected === link;
    const update = (link: DeviceLink, watching: boolean) =>
      link.request('usage-watch', { backendId, watching, version: ++this.usageVersion }, undefined, 5000);
    const stopWatching = (link?: DeviceLink) => {
      if (!link || link.closed) return;
      void update(link, false).catch(() => {});
    };
    const receive = (snapshot: UsageSnapshot) => {
      if (!disposed && selected && generation === this.generation) notify(snapshot);
    };
    const legacy = async (link: DeviceLink) => {
      try {
        const value = await link.rpc<AgentUsage>({ ...apiCall('/usage'), backendId });
        if (current(link)) notify({ state: value.available ? 'current' : 'unavailable', value });
      } catch {
        if (current(link)) notify({ state: 'stale' });
      } finally {
        if (current(link)) timer = setTimeout(() => void legacy(link), 60_000);
      }
    };
    const subscribe = (link: DeviceLink) => {
      void update(link, true).catch((error) => {
        if (!current(link)) return;
        if (error instanceof RpcError && [400, 404].includes(error.status)) void legacy(link);
        else {
          notify({ state: 'stale' });
          timer = setTimeout(() => subscribe(link), 5000);
        }
      });
    };
    const sync = () => {
      const next =
        generation === this.generation && this.online && document.visibilityState !== 'hidden'
          ? this.link()
          : undefined;
      if (next === selected) return;
      clearTimeout(timer);
      const previous = selected;
      selected = next;
      if (next) subscribe(next);
      else {
        stopWatching(previous);
        notify({ state: 'stale' });
      }
    };
    this.usageWatchers.set(backendId, receive);
    const unsubscribe = this.onChange(sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (this.usageWatchers.get(backendId) === receive) {
        this.usageWatchers.delete(backendId);
        if (generation === this.generation && this.online) stopWatching(this.link());
      }
      unsubscribe();
      document.removeEventListener('visibilitychange', sync);
    };
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
  async request(
    type: string,
    data: Record<string, unknown>,
    bytes?: Uint8Array,
    bulk = false,
    backendId = this.backendId,
  ) {
    if (type === 'file') data = { backendId, ...data };
    if (!this.online) await this.connect();
    if (bulk && !this.links.get('direct:bulk')) await this.relay('bulk');
    const link = this.link(bulk ? 'bulk' : 'control');
    const extended =
      bulk || (type === 'file' && (data.action === 'storage-plan' || data.action === 'storage-import'));
    const result = await link.request(type, data, bytes, extended ? 120000 : 30000);
    this.metrics[
      link === this.links.get(`direct:${bulk ? 'bulk' : 'control'}`) ? 'directBytes' : 'relayBytes'
    ] += (bytes?.length ?? 0) + (result.bytes?.length ?? 0) + JSON.stringify(result.value ?? null).length;
    return result;
  }
  async cachedThread(threadId: string, backendId = this.backendId): Promise<ThreadView | undefined> {
    await this.init();
    return (
      this.views.get(conversationKey(backendId, threadId)) ??
      (await this.cache.get<CachedThread>(this.key(`thread:${threadId}`, backendId)))
    )?.view;
  }
  async cached<T>(path: string, backendId = this.backendId): Promise<T | undefined> {
    await this.init();
    const entry = await this.cache.get<{ value: T }>(
      this.key(`rpc:${contentVersion(apiCall(path))}`, backendId),
    );
    return entry?.value;
  }
  async api<T>(path: string, init?: RequestInit, backendId = this.backendId): Promise<T> {
    await this.init();
    if (!this.host) throw new RpcError('请先扫码配对', 401);
    const call = apiCall(
      path,
      init?.method,
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    );
    if (call.method === 'session.read')
      return {
        device: { id: this.host.deviceId },
        status: this.statuses.get(backendId) ?? (backendId === this.backendId ? this.status : undefined),
      } as T;
    const cacheable =
      (init?.method ?? 'GET') === 'GET' &&
      !['operation.read', 'operations.list', 'status.read'].includes(call.method);
    const key = this.key(`rpc:${contentVersion(call)}`, backendId),
      old = cacheable ? await this.cache.get<{ hash: string; value: T }>(key) : undefined;
    if (!this.online) {
      if (old) return old.value;
      await this.connect();
    }
    const { value } = await this.request('rpc', { call: { ...call, backendId }, knownHash: old?.hash });
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
    for (const storage of [localStorage, sessionStorage])
      for (const key of Object.keys(storage))
        if (
          ['pocket-pending:', 'pocket-drafts:'].some(
            (prefix) => key === `${prefix}${deviceId}` || key.startsWith(`${prefix}${deviceId}:`),
          )
        )
          storage.removeItem(key);
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
    this.usageWatchers.clear();
    this.views.clear();
    this.status = undefined;
    this.statuses.clear();
    this.sessionId = browserId();
    this.changed();
  }
}
export const deviceSession = new DeviceSession();
/** Compatibility bridge for existing UI components; all requests still use the fixed RPC contract. */
export async function remoteFetch(
  path: string,
  init?: RequestInit,
  backendId = deviceSession.backendId,
): Promise<Response> {
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    const match = /^\/api\/threads\/([^/]+)\/media$/.exec(path);
    const data =
      match && typeof init?.body === 'string'
        ? await (
            await import('./file-client')
          ).mediaContent(decodeURIComponent(match[1]), JSON.parse(init.body).path, backendId)
        : await deviceSession.api(path, init, backendId);
    return Response.json(data);
  } catch (error) {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return Response.json(
      { error: error instanceof Error ? error.message : '请求失败' },
      { status: error instanceof RpcError && error.status >= 400 ? error.status : 503 },
    );
  }
}
