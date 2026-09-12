/**
 * One guarded, budgeted, rate-limited retrieval.
 *
 * Order matters here and is the point of the module:
 *
 *   budget check -> destination guard -> rate limit -> request
 *
 * The guard runs before the socket exists, and again for every redirect
 * target, so an archived redirect aimed at a private address is refused
 * without a connection attempt. The budget is checked before each attempt and
 * charged after it, so retries and redirect hops are paid for; a retry that is
 * not charged bounds nothing.
 */

import type { BudgetLedger, BudgetLimit } from './budget.ts';
import { checkDestination, type DestinationPolicy, type DnsResolver } from './destination.ts';
import type { Clock } from './clock.ts';
import type { RedirectHop } from './job.ts';
import { failure, type Failure } from './outcomes.ts';
import { parseRetryAfter, type RateLimiter } from './ratelimit.ts';
import type { HttpResponse, HttpTransport } from './transport.ts';

export interface FetchContext {
  transport: HttpTransport;
  resolver: DnsResolver;
  policy: DestinationPolicy;
  limiter: RateLimiter;
  ledger: BudgetLedger;
  clock: Clock;
  timeoutMs: number;
  /** Wait applied when a throttling response carries no Retry-After. */
  defaultBackoffMs: number;
}

export type RequestKind = 'index' | 'resource';

interface Trace {
  redirectChain: RedirectHop[];
  attempts: number;
  bytesRead: number;
  finalUrl: string;
}

export type FetchResult =
  | ({ ok: true; response: HttpResponse } & Trace)
  /** A budget stopped the attempt. The item is unattempted, not failed. */
  | ({ ok: false; exhausted: BudgetLimit; failure: null } & Trace)
  | ({ ok: false; exhausted: null; failure: Failure } & Trace);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const THROTTLE_STATUSES = new Set([429, 503]);

export async function fetchResource(
  context: FetchContext,
  startUrl: string,
  kind: RequestKind,
): Promise<FetchResult> {
  const redirectChain: RedirectHop[] = [];
  const visited = new Set<string>([startUrl]);
  let attempts = 0;
  let bytesRead = 0;
  let url = startUrl;

  const trace = (): Trace => ({ redirectChain, attempts, bytesRead, finalUrl: url });

  for (let hop = 0; hop <= context.ledger.budgets.maxRedirects; hop += 1) {
    let response: HttpResponse | null = null;
    let hopFailure: Failure | null = null;

    for (let tryIndex = 0; tryIndex < context.ledger.budgets.maxAttemptsPerItem; tryIndex += 1) {
      const allowance = context.ledger.canAttempt(kind);
      if (!allowance.ok) {
        return { ok: false, exhausted: allowance.limit, failure: null, ...trace() };
      }

      const destination = await checkDestination(url, context.policy, context.resolver);
      if (!destination.allowed) {
        return {
          ok: false,
          failure: failure('destination-refused', destination.reason),
          exhausted: null,
          ...trace(),
        };
      }

      await context.limiter.acquire();
      context.ledger.recordAttempt(kind);
      attempts += 1;

      const maxBytes = context.ledger.remainingResponseBytes();
      let received: HttpResponse;
      try {
        received = await context.transport(
          { url, headers: {} },
          { maxBytes, timeoutMs: context.timeoutMs, pinnedAddresses: destination.addresses },
        );
      } catch (error) {
        hopFailure = failure('transport-error', describe(error), { retryable: true });
        await context.limiter.backOff(context.defaultBackoffMs);
        continue;
      }

      bytesRead += received.body.length;
      context.ledger.recordBytes(received.body.length);

      if (THROTTLE_STATUSES.has(received.status)) {
        const retryAfter = parseRetryAfter(received.headers['retry-after'], context.clock.now());
        hopFailure = failure('provider-throttled', `provider returned ${received.status}`, {
          httpStatus: received.status,
          retryable: true,
        });
        await context.limiter.backOff(retryAfter ?? context.defaultBackoffMs);
        continue;
      }

      if (received.status >= 500) {
        hopFailure = failure('http-status', `provider returned ${received.status}`, {
          httpStatus: received.status,
          retryable: true,
        });
        await context.limiter.backOff(context.defaultBackoffMs);
        continue;
      }

      response = received;
      hopFailure = null;
      break;
    }

    if (response === null) {
      return {
        ok: false,
        failure: hopFailure ?? failure('transport-error', 'no attempt produced a response'),
        exhausted: null,
        ...trace(),
      };
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status >= 400) {
        // A 4xx is a definite answer: the provider has nothing to serve here.
        // Retrying it spends budget to learn the same thing again.
        return {
          ok: false,
          failure: failure('http-status', `provider returned ${response.status}`, {
            httpStatus: response.status,
            retryable: response.status === 408,
          }),
          exhausted: null,
          ...trace(),
        };
      }
      return { ok: true, response, ...trace() };
    }

    const location = response.headers['location'];
    if (location === undefined || location === '') {
      return {
        ok: false,
        failure: failure('http-status', `redirect ${response.status} carried no Location`, {
          httpStatus: response.status,
        }),
        exhausted: null,
        ...trace(),
      };
    }

    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      return {
        ok: false,
        failure: failure('http-status', `redirect target ${location} is not a URL`, {
          httpStatus: response.status,
        }),
        exhausted: null,
        ...trace(),
      };
    }

    if (visited.has(next)) {
      redirectChain.push({ from: url, to: next, status: response.status });
      url = next;
      return {
        ok: false,
        failure: failure('redirect-loop', `redirect returned to ${next}`, { httpStatus: response.status }),
        exhausted: null,
        ...trace(),
      };
    }

    redirectChain.push({ from: url, to: next, status: response.status });
    visited.add(next);
    url = next;
  }

  return {
    ok: false,
    failure: failure('redirect-limit', `more than ${context.ledger.budgets.maxRedirects} redirects`),
    exhausted: null,
    ...trace(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
