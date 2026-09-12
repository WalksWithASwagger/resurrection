/**
 * One shared provider rate limit.
 *
 * The limiter is per provider host rather than per job, because the archive
 * does not care how many local jobs a single operator is running
 * (docs/SPEC.md section 5.5). Retry-After is honoured rather than evaded.
 */

import type { Clock } from './clock.ts';

export class RateLimiter {
  readonly minIntervalMs: number;
  private readonly clock: Clock;
  private nextAllowedAt = 0;
  private waits = 0;
  private totalWaitedMs = 0;

  constructor(minIntervalMs: number, clock: Clock) {
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
  }

  async acquire(): Promise<number> {
    const now = this.clock.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    if (waitMs > 0) {
      this.waits += 1;
      this.totalWaitedMs += waitMs;
      await this.clock.sleep(waitMs);
    }
    this.nextAllowedAt = this.clock.now() + this.minIntervalMs;
    return waitMs;
  }

  /** Push the next allowed time out, for an explicit Retry-After. */
  async backOff(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    this.waits += 1;
    this.totalWaitedMs += milliseconds;
    await this.clock.sleep(milliseconds);
    this.nextAllowedAt = this.clock.now() + this.minIntervalMs;
  }

  snapshot(): { waits: number; totalWaitedMs: number } {
    return { waits: this.waits, totalWaitedMs: this.totalWaitedMs };
  }
}

/** Seconds or an HTTP-date, in milliseconds. Null when unusable. */
export function parseRetryAfter(header: string | undefined, now: number): number | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
