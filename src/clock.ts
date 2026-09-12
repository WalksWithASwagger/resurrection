/**
 * Time and waiting, injected everywhere so budgets, rate limiting and
 * Retry-After handling are deterministic in fixture runs.
 */

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

/** A clock that advances only when something waits on it. */
export function createTestClock(startedAt = 0): Clock & { advance(ms: number): void; elapsed(): number } {
  let current = startedAt;
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
    elapsed: () => current - startedAt,
  };
}
