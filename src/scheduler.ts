const DEBOUNCE_MS = 2_000;
const MAX_WAIT_MS = 15_000;
const POLL_VISIBLE_MS = 4_000;
const POLL_HIDDEN_MS = 60_000;

export interface SchedulerOpts {
  run: () => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  isVisible: () => boolean;
}

/** Decides when to sync. Guarantees run() never overlaps: one in flight, plus a single "again" flag. */
export class Scheduler {
  private debounce: number | null = null;
  private poll: number | null = null;
  private resume: number | null = null;
  private firstEdit: number | null = null;
  private running = false;
  private again = false;
  private stopped = true;
  private pausedUntil = 0;

  constructor(private o: SchedulerOpts) {}

  start(): void {
    this.stopped = false;
    this.armPoll();
  }

  stop(): void {
    this.stopped = true;
    this.again = false;
    this.firstEdit = null;
    for (const t of [this.debounce, this.poll, this.resume]) if (t !== null) this.o.clearTimer(t);
    this.debounce = this.poll = this.resume = null;
  }

  onLocalChange(): void {
    if (this.stopped) return;
    const now = this.o.now();
    this.firstEdit ??= now;
    if (this.debounce !== null) this.o.clearTimer(this.debounce);
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, this.firstEdit + MAX_WAIT_MS - now));
    this.debounce = this.o.setTimer(() => { this.debounce = null; void this.attempt(); }, delay);
  }

  onVisibilityChange(): void {
    if (this.stopped) return;
    this.armPoll();
    if (this.o.isVisible()) void this.attempt();
  }

  pauseUntil(ts: number): void {
    this.pausedUntil = ts;
  }

  private armPoll(): void {
    if (this.poll !== null) this.o.clearTimer(this.poll);
    const ms = this.o.isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
    this.poll = this.o.setTimer(() => { this.armPoll(); void this.attempt(); }, ms);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const wait = this.pausedUntil - this.o.now();
    if (wait > 0) {
      if (this.resume !== null) this.o.clearTimer(this.resume);
      this.resume = this.o.setTimer(() => { this.resume = null; void this.attempt(); }, wait);
      return;
    }
    if (this.running) { this.again = true; return; }
    this.running = true;
    this.firstEdit = null;
    try { await this.o.run(); } catch { /* run() reports its own errors */ }
    this.running = false;
    if (this.again) { this.again = false; await this.attempt(); }
  }
}
