/** Client-side write budget: starts full, refills continuously. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(private capacity: number, private refillPerMin: number, private now: () => number) {
    this.tokens = capacity;
    this.at = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.at) * this.refillPerMin) / 60_000);
    this.at = t;
  }

  tryTake(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  msUntil(n: number): number {
    this.refill();
    return Math.max(0, Math.ceil(((n - this.tokens) * 60_000) / this.refillPerMin));
  }
}
