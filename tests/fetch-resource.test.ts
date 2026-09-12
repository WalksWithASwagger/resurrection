/**
 * The typed failure states of a single retrieval.
 *
 * Each case here is a distinct reason a request produced no usable bytes. They
 * are separate states rather than one "error" because a reconstruction has to
 * act differently on each: a throttle is waited out, a redirect loop is a
 * provider fault, and a refused destination is a security decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BudgetLedger,
  createTestClock,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_BUDGETS,
  EMPTY_SPEND,
  RateLimiter,
  createFixtureTransport,
  fetchResource,
  parseRetryAfter,
  type Budgets,
  type FetchContext,
  type FixtureManifest,
  type FixtureRule,
} from '../src/index.ts';

const START = 'https://web.archive.org/web/19990315120000id_/http://demo.invalid/x';

function contextFor(
  rules: FixtureRule[],
  budgets: Partial<Budgets> = {},
): { context: FetchContext; calls: () => number } {
  const manifest: FixtureManifest = {
    description: 'inline rules for one retrieval',
    dns: { 'web.archive.org': ['203.0.113.10'] },
    rules,
  };
  const handle = createFixtureTransport(manifest);
  const clock = createTestClock(0);
  const merged: Budgets = { ...DEFAULT_BUDGETS, ...budgets };
  return {
    context: {
      transport: handle.transport,
      resolver: handle.resolver,
      policy: { allowedHosts: ['web.archive.org'], allowedPorts: DEFAULT_ALLOWED_PORTS },
      limiter: new RateLimiter(0, clock),
      ledger: new BudgetLedger(merged, clock, EMPTY_SPEND),
      clock,
      timeoutMs: 1000,
      defaultBackoffMs: 10,
    },
    calls: () => handle.calls.length,
  };
}

const rule = (id: string, respond: FixtureRule['respond']): FixtureRule => ({
  id,
  urlIncludes: ['web.archive.org'],
  respond,
});

test('a server error is retried up to the per-item attempt budget, then fails', async () => {
  const { context, calls } = contextFor([rule('always-500', [{ status: 500, bodyText: 'oops' }])], {
    maxAttemptsPerItem: 3,
  });

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'http-status');
  assert.equal(result.attempts, 3);
  assert.equal(calls(), 3);
  assert.equal(context.ledger.snapshot().requests, 3, 'every retry is charged');
});

test('a transport failure is a transport error, not a fabricated status', async () => {
  const { context } = contextFor([rule('refused', [{ error: 'ECONNRESET' }])], { maxAttemptsPerItem: 2 });

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'transport-error');
  assert.equal(result.ok === false ? result.failure?.httpStatus : 0, null);
});

test('persistent throttling ends as provider-throttled, never as success', async () => {
  const { context } = contextFor(
    [rule('throttled', [{ status: 429, headers: { 'retry-after': '1' }, bodyText: 'slow down' }])],
    { maxAttemptsPerItem: 2 },
  );

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'provider-throttled');
  assert.equal(result.attempts, 2);
});

test('a redirect back to a visited URL is a loop, not an endless chain', async () => {
  const other = 'https://web.archive.org/web/19990315120001id_/http://demo.invalid/x';
  const { context } = contextFor([
    { id: 'second', urlIncludes: ['19990315120001'], respond: [{ status: 302, headers: { location: START } }] },
    { id: 'first', urlIncludes: ['19990315120000'], respond: [{ status: 302, headers: { location: other } }] },
  ]);

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'redirect-loop');
});

test('a chain longer than the redirect budget stops at the limit', async () => {
  const { context, calls } = contextFor(
    [
      {
        id: 'always-redirect',
        urlIncludes: ['web.archive.org'],
        respond: [
          { status: 302, headers: { location: `${START}?hop=1` } },
          { status: 302, headers: { location: `${START}?hop=2` } },
          { status: 302, headers: { location: `${START}?hop=3` } },
          { status: 302, headers: { location: `${START}?hop=4` } },
        ],
      },
    ],
    { maxRedirects: 2 },
  );

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'redirect-limit');
  assert.equal(calls(), 3, 'the initial request plus the allowed hops');
});

test('a redirect with no Location is a failure rather than a silent stop', async () => {
  const { context } = contextFor([rule('bare-redirect', [{ status: 302 }])]);

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.failure?.kind : null, 'http-status');
});

test('a body past the response cap comes back marked truncated', async () => {
  const { context } = contextFor([rule('huge', [{ status: 200, bodyText: 'x'.repeat(100) }])], {
    maxResponseBytes: 10,
  });

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.response.truncated : false, true);
  assert.equal(result.ok === true ? result.response.body.length : 0, 10);
});

test('an exhausted budget is reported as exhaustion, not as a fetch failure', async () => {
  const { context, calls } = contextFor([rule('never-reached', [{ status: 200, bodyText: 'ok' }])], {
    maxRequests: 0,
  });

  const result = await fetchResource(context, START, 'resource');

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.exhausted : null, 'requests');
  assert.equal(result.ok === false ? result.failure : 'set', null);
  assert.equal(calls(), 0);
});

test('Retry-After is read as seconds or as an HTTP date, and ignored when unusable', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
});
