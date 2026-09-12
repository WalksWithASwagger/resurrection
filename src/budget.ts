/**
 * Budget accounting.
 *
 * Every HTTP attempt is charged, including retries and redirect hops. A retry
 * that is not charged is a budget that does not bound anything, so the ledger
 * counts attempts rather than items. Index requests have their own counter
 * (docs/SPEC.md section 5.5: "a separate index budget") and are also charged
 * to the shared request total, so one number still bounds provider load.
 *
 * Spend is persisted with the job, so a resumed run continues the same
 * accounting instead of starting from zero.
 */

import type { Clock } from './clock.ts';

export interface Budgets {
  /** Total HTTP attempts, retries and redirect hops included. */
  maxRequests: number;
  /** Inventory attempts, charged to maxRequests as well. */
  maxIndexRequests: number;
  /** Bytes read across all responses, failed attempts included. */
  maxTotalBytes: number;
  /** Cap for a single response body. */
  maxResponseBytes: number;
  maxElapsedMs: number;
  maxRedirects: number;
  /** Attempts per item before it is recorded as failed. */
  maxAttemptsPerItem: number;
  /** Selected pages and discovered dependencies, bounded separately. */
  maxPages: number;
  maxDependencies: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxRequests: 400,
  maxIndexRequests: 20,
  maxTotalBytes: 200 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxElapsedMs: 15 * 60 * 1000,
  maxRedirects: 5,
  maxAttemptsPerItem: 3,
  maxPages: 30,
  maxDependencies: 500,
};

export interface BudgetSpend {
  requests: number;
  indexRequests: number;
  bytes: number;
  elapsedMs: number;
}

export const EMPTY_SPEND: BudgetSpend = { requests: 0, indexRequests: 0, bytes: 0, elapsedMs: 0 };

export type BudgetLimit = 'requests' | 'index-requests' | 'bytes' | 'time';

export type BudgetCheck = { ok: true } | { ok: false; limit: BudgetLimit; message: string };

export class BudgetLedger {
  readonly budgets: Budgets;
  private readonly clock: Clock;
  private readonly startedAt: number;
  private readonly carriedElapsedMs: number;
  private requests: number;
  private indexRequests: number;
  private bytes: number;

  constructor(budgets: Budgets, clock: Clock, carried: BudgetSpend = EMPTY_SPEND) {
    this.budgets = budgets;
    this.clock = clock;
    this.startedAt = clock.now();
    this.requests = carried.requests;
    this.indexRequests = carried.indexRequests;
    this.bytes = carried.bytes;
    this.carriedElapsedMs = carried.elapsedMs;
  }

  elapsedMs(): number {
    return this.carriedElapsedMs + (this.clock.now() - this.startedAt);
  }

  /** Checked before each attempt, so a refusal never consumes the attempt. */
  canAttempt(kind: 'index' | 'resource'): BudgetCheck {
    if (this.elapsedMs() >= this.budgets.maxElapsedMs) {
      return { ok: false, limit: 'time', message: `time budget ${this.budgets.maxElapsedMs}ms exhausted` };
    }
    if (this.requests >= this.budgets.maxRequests) {
      return { ok: false, limit: 'requests', message: `request budget ${this.budgets.maxRequests} exhausted` };
    }
    if (kind === 'index' && this.indexRequests >= this.budgets.maxIndexRequests) {
      return {
        ok: false,
        limit: 'index-requests',
        message: `index request budget ${this.budgets.maxIndexRequests} exhausted`,
      };
    }
    if (this.bytes >= this.budgets.maxTotalBytes) {
      return { ok: false, limit: 'bytes', message: `byte budget ${this.budgets.maxTotalBytes} exhausted` };
    }
    return { ok: true };
  }

  recordAttempt(kind: 'index' | 'resource'): void {
    this.requests += 1;
    if (kind === 'index') this.indexRequests += 1;
  }

  recordBytes(count: number): void {
    this.bytes += count;
  }

  /** Bytes a single response may still read, honouring both caps. */
  remainingResponseBytes(): number {
    return Math.max(0, Math.min(this.budgets.maxResponseBytes, this.budgets.maxTotalBytes - this.bytes));
  }

  snapshot(): BudgetSpend {
    return {
      requests: this.requests,
      indexRequests: this.indexRequests,
      bytes: this.bytes,
      elapsedMs: this.elapsedMs(),
    };
  }
}
