/** Process-wide token bucket: 8 requests per second, burst 10. */

export const RATE_PER_SEC = 8;
export const BURST = 10;

function defaultSleep(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  private milliTokens: number;
  private updatedMs: number;
  private readonly clockMs: () => number;
  private readonly sleepFn: (durationMs: number) => void;

  constructor(
    ratePerSec = RATE_PER_SEC,
    burst = BURST,
    clockMs: () => number = () => Date.now(),
    sleepFn: (durationMs: number) => void = defaultSleep,
  ) {
    if (ratePerSec < 1 || burst < 1) {
      throw new Error("rate and burst must be positive");
    }
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.clockMs = clockMs;
    this.sleepFn = sleepFn;
    this.milliTokens = burst * 1000;
    this.updatedMs = clockMs();
  }

  acquire(tokens = 1): number {
    if (tokens < 1 || tokens > this.burst) {
      throw new Error("token count is out of range");
    }
    const needed = tokens * 1000;
    let slept = 0;
    for (;;) {
      this.refill();
      if (this.milliTokens >= needed) {
        this.milliTokens -= needed;
        return slept;
      }
      const deficit = needed - this.milliTokens;
      const wait = Math.ceil(deficit / this.ratePerSec);
      this.sleepFn(wait);
      slept += wait;
    }
  }

  private refill(): void {
    const now = this.clockMs();
    const elapsed = now - this.updatedMs;
    if (elapsed <= 0) {
      return;
    }
    this.updatedMs = now;
    const added = elapsed * this.ratePerSec;
    this.milliTokens = Math.min(this.burst * 1000, this.milliTokens + added);
  }
}
