import type { UsageSnapshot } from '../shared/usage.js';
import type { AgentBackend } from './backends/types.js';

const INTERVAL = 60_000;
const MIN_READ_GAP = 5_000;
const TURN_SETTLE = 1_500;

/** Shares a single quota read and snapshot across the active viewers of one adapter. */
export class UsageFeed {
  snapshot: UsageSnapshot = { state: 'loading' };
  private active = false;
  private connected = false;
  private epoch = 0;
  private reading = false;
  private failures = 0;
  private lastRead = -Infinity;
  private nextRead = Infinity;
  private refreshAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private backend: AgentBackend,
    private publish: (snapshot: UsageSnapshot) => void,
  ) {}

  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      clearTimeout(this.timer);
      this.nextRead = Infinity;
      return;
    }
    const delay = this.refreshAt - Date.now();
    if (this.snapshot.state === 'current' && delay <= 0) this.setStale();
    if (this.connected) this.schedule(this.snapshot.state === 'current' ? delay : 0);
    else this.setStale();
  }

  setConnected(connected: boolean) {
    if (connected === this.connected) return;
    this.connected = connected;
    if (!connected) {
      this.epoch++;
      this.nextRead = Infinity;
      clearTimeout(this.timer);
      this.setStale();
    } else {
      this.failures = 0;
      this.schedule(0);
    }
  }

  turnFinished() {
    if (!this.failures && this.snapshot.state !== 'unavailable') this.schedule(TURN_SETTLE);
  }

  private setStale() {
    if (this.snapshot.state === 'stale') return;
    this.snapshot = { state: 'stale', value: this.snapshot.value };
    this.publish(this.snapshot);
  }

  private schedule(delay: number) {
    if (!this.active || !this.connected) return;
    this.nextRead = Math.min(this.nextRead, Date.now() + delay);
    this.arm();
  }

  private arm() {
    clearTimeout(this.timer);
    if (this.reading || !this.active || !this.connected || !Number.isFinite(this.nextRead)) return;
    const due = Math.max(this.nextRead, this.lastRead + MIN_READ_GAP);
    this.timer = setTimeout(() => void this.read(), Math.max(0, due - Date.now()));
    this.timer.unref();
  }

  private async read() {
    const epoch = this.epoch;
    this.reading = true;
    this.lastRead = Date.now();
    this.nextRead = Infinity;
    try {
      const value = await this.backend.usage?.({ fresh: true });
      if (epoch !== this.epoch) return;
      this.failures = 0;
      this.snapshot = { state: value?.available ? 'current' : 'unavailable', value };
      this.publish(this.snapshot);
      const resets =
        value?.buckets.flatMap((bucket) =>
          bucket.windows.flatMap(({ resetsAt }) => (resetsAt && resetsAt > Date.now() ? [resetsAt] : [])),
        ) ?? [];
      const delay = Math.min(INTERVAL, Math.min(...resets) - Date.now() + 1500);
      this.refreshAt = Date.now() + delay;
      this.schedule(delay);
    } catch {
      if (epoch !== this.epoch) return;
      this.setStale();
      this.nextRead = Infinity;
      this.schedule(Math.min(INTERVAL, 5_000 * 2 ** Math.min(this.failures++, 4)));
    } finally {
      this.reading = false;
      this.arm();
    }
  }
}
