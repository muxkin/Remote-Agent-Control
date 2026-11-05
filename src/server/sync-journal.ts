import { randomUUID } from 'node:crypto';
import { diffViews } from '../shared/delta.js';
import { contentVersion, type SyncCheckpoint, type SyncUpdate } from '../shared/sync.js';
import type { ThreadView, ThreadDelta } from '../shared/types.js';

interface Entry {
  at: number;
  bytes: number;
  delta: ThreadDelta;
}
interface Journal {
  epoch: string;
  view: ThreadView;
  nativeRevision: number;
  entries: Entry[];
  bytes: number;
  touched: number;
  version: string;
}
export class SyncJournal {
  private threads = new Map<string, Journal>();
  private totalBytes = 0;
  constructor(
    private now = () => Date.now(),
    private limits = { entries: 1000, bytes: 8 * 1024 * 1024, total: 64 * 1024 * 1024, age: 600000 },
  ) {}
  update(native: ThreadView): Journal {
    const before = this.threads.get(native.id),
      now = this.now();
    const version = contentVersion(native);
    if (before && before.version === version) {
      before.touched = now;
      this.prune();
      return before;
    }
    if (!before || native.revision < before.nativeRevision) {
      if (before) this.totalBytes -= before.bytes;
      const next: Journal = {
        epoch: randomUUID(),
        view: { ...native, revision: 0 },
        nativeRevision: native.revision,
        entries: [],
        bytes: 0,
        touched: now,
        version,
      };
      this.threads.set(native.id, next);
      this.prune();
      return next;
    }
    const view = { ...native, revision: before.view.revision + 1 };
    const delta = diffViews(before.view, view);
    const bytes = Buffer.byteLength(JSON.stringify(delta));
    before.entries.push({ delta, bytes, at: now });
    before.bytes += bytes;
    this.totalBytes += bytes;
    Object.assign(before, { view, nativeRevision: native.revision, touched: now, version });
    this.prune();
    return before;
  }
  resume(native: ThreadView, known?: SyncCheckpoint): SyncUpdate[] {
    const state = this.update(native);
    if (known?.epoch === state.epoch && known.revision < state.view.revision) {
      const index = state.entries.findIndex((entry) => entry.delta.baseRevision === known.revision);
      if (index >= 0)
        return state.entries
          .slice(index)
          .map((entry) => ({ kind: 'delta', epoch: state.epoch, delta: entry.delta }));
    }
    const { messages, ...thread } = state.view;
    return [
      {
        kind: 'manifest',
        epoch: state.epoch,
        thread,
        order: messages.map((message) => message.id),
        changed: messages.filter((message) => known?.versions?.[message.id] !== contentVersion(message)),
      },
    ];
  }
  private prune() {
    const now = this.now();
    for (const state of this.threads.values()) {
      while (
        state.entries.length &&
        (state.entries.length > this.limits.entries ||
          state.bytes > this.limits.bytes ||
          state.entries[0].at < now - this.limits.age)
      )
        this.drop(state);
    }
    while (this.totalBytes > this.limits.total) {
      const state = [...this.threads.values()]
        .filter((s) => s.entries.length)
        .sort((a, b) => a.entries[0].at - b.entries[0].at)[0];
      if (!state) break;
      this.drop(state);
    }
    while (this.threads.size > 128) {
      const [id, state] = [...this.threads].sort((a, b) => a[1].touched - b[1].touched)[0];
      this.threads.delete(id);
      this.totalBytes -= state.bytes;
    }
  }
  private drop(state: Journal) {
    const entry = state.entries.shift()!;
    state.bytes -= entry.bytes;
    this.totalBytes -= entry.bytes;
  }
  get bytes() {
    return this.totalBytes;
  }
}
