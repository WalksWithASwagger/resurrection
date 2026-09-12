import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BudgetLedger, createTestClock, DEFAULT_BUDGETS, EMPTY_SPEND } from '../src/index.ts';

function ledgerWith(overrides: Partial<typeof DEFAULT_BUDGETS>, carried = EMPTY_SPEND) {
  const clock = createTestClock(0);
  return { clock, ledger: new BudgetLedger({ ...DEFAULT_BUDGETS, ...overrides }, clock, carried) };
}

test('retries are charged, so a retrying item cannot run past the request budget', () => {
  const { ledger } = ledgerWith({ maxRequests: 3 });

  ledger.recordAttempt('resource');
  ledger.recordAttempt('resource');
  ledger.recordAttempt('resource');

  const check = ledger.canAttempt('resource');
  assert.equal(check.ok, false);
  assert.equal(check.ok === false ? check.limit : null, 'requests');
  assert.equal(ledger.snapshot().requests, 3);
});

test('index requests have their own limit and are also charged to the shared total', () => {
  const { ledger } = ledgerWith({ maxIndexRequests: 2, maxRequests: 10 });

  ledger.recordAttempt('index');
  ledger.recordAttempt('index');

  const index = ledger.canAttempt('index');
  assert.equal(index.ok, false);
  assert.equal(index.ok === false ? index.limit : null, 'index-requests');
  assert.equal(ledger.canAttempt('resource').ok, true);
  assert.equal(ledger.snapshot().requests, 2);
  assert.equal(ledger.snapshot().indexRequests, 2);
});

test('a single response may never read more than the remaining total byte budget', () => {
  const { ledger } = ledgerWith({ maxResponseBytes: 1000, maxTotalBytes: 1500 });

  assert.equal(ledger.remainingResponseBytes(), 1000);
  ledger.recordBytes(900);
  assert.equal(ledger.remainingResponseBytes(), 600);
  ledger.recordBytes(600);
  assert.equal(ledger.remainingResponseBytes(), 0);
  assert.equal(ledger.canAttempt('resource').ok, false);
});

test('elapsed time is a budget, and waiting on the rate limit spends it', async () => {
  const { clock, ledger } = ledgerWith({ maxElapsedMs: 100 });

  await clock.sleep(99);
  assert.equal(ledger.canAttempt('resource').ok, true);
  await clock.sleep(1);

  const check = ledger.canAttempt('resource');
  assert.equal(check.ok, false);
  assert.equal(check.ok === false ? check.limit : null, 'time');
});

test('a resumed run continues the earlier spend instead of restarting it', () => {
  const { ledger } = ledgerWith(
    { maxRequests: 5 },
    { requests: 4, indexRequests: 1, bytes: 10, elapsedMs: 50 },
  );

  ledger.recordAttempt('resource');

  assert.equal(ledger.canAttempt('resource').ok, false);
  assert.equal(ledger.snapshot().requests, 5);
  assert.equal(ledger.elapsedMs(), 50);
});
