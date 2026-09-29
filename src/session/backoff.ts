/** Exponential reconnect delay: 5 s, doubled, capped at 5 min, reset on success (spec 001 FR-5). */
export class Backoff {
  private delayMs: number;

  constructor(
    private readonly initialMs = 5_000,
    private readonly maxMs = 300_000,
  ) {
    this.delayMs = initialMs;
  }

  /** The delay to wait now; the following one is doubled. */
  next(): number {
    const current = this.delayMs;
    this.delayMs = Math.min(this.maxMs, this.delayMs * 2);
    return current;
  }

  reset(): void {
    this.delayMs = this.initialMs;
  }
}
