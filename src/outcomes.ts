/**
 * Typed terminal states for one work item.
 *
 * The sets here are closed on purpose. A new state is a deliberate change with
 * a fixture behind it, not an open-ended string.
 *
 * Two axes live here and are never merged. `FailureKind` says whether a
 * request produced usable bytes, which is what retry and resume act on.
 * `ItemOutcome`, added by issue #5 further down this file, says whether an
 * item carries recovered content, which bytes alone do not establish. Every
 * `FailureKind` projects onto exactly one `ItemOutcome` through one documented
 * mapping, so neither axis is a parallel copy of the other.
 */

/** Why a request could not produce validated bytes. */
export type FailureKind =
  /** The destination control refused the URL or a redirect target. */
  | 'destination-refused'
  /** The connection or the provider adapter threw before a response arrived. */
  | 'transport-error'
  /** The provider kept refusing within the retry budget. */
  | 'provider-throttled'
  /** More redirect hops than the configured limit. */
  | 'redirect-limit'
  /** A redirect returned to a URL already visited in this chain. */
  | 'redirect-loop'
  /** A response arrived with a status that carries no usable body. */
  | 'http-status'
  /** Status 200 carrying a provider error document instead of the capture. */
  | 'archive-error-page'
  /** The body did not match the type the referring markup implied. */
  | 'content-type-mismatch'
  /** A success status with a zero-length body. */
  | 'empty-body'
  /** The body exceeded the per-response byte cap. */
  | 'oversized-body';

/** Why an item was never attempted. An unattempted item is not a failure. */
export type UnattemptedReason =
  | 'queued'
  | 'budget-exhausted'
  | 'paused'
  | 'cancelled'
  | 'out-of-scope';

export interface Failure {
  kind: FailureKind;
  message: string;
  httpStatus: number | null;
  /** A resumed job may retry this item; a permanent failure it may not. */
  retryable: boolean;
}

export function failure(
  kind: FailureKind,
  message: string,
  options: { httpStatus?: number | null; retryable?: boolean } = {},
): Failure {
  return {
    kind,
    message,
    httpStatus: options.httpStatus ?? null,
    retryable: options.retryable ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* content outcomes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What one item actually holds, once the fetch is over.
 *
 * `FailureKind` above answers a different question: whether a request produced
 * usable bytes. It drives retry and resume, so it stays exactly as M1 defined
 * it. This union answers whether the item carries recovered *content*, which
 * bytes alone do not establish: an archived response can return HTTP 200 and
 * still be an interstitial, the origin's own 404 template, a parked-domain
 * holding page or a frameset whose frames were never captured.
 *
 * The two axes overlap, so every `FailureKind` maps to exactly one outcome
 * through `OUTCOME_BY_FAILURE_KIND` below, and nothing else does the mapping.
 * An item ends with exactly one outcome.
 *
 * The set is closed. Adding a category is a deliberate change with a fixture
 * behind it (issue #5). Identifiers are kebab-case, matching the rest of this
 * module; issue #5's text spells them snake_case.
 *
 * Only `ok` is eligible to become an M2 reference.
 */
export type ItemOutcome =
  /** Validated bytes that carry the captured content. */
  | 'ok'
  /** A provider error or interstitial document, by Wayback's own markers. */
  | 'archive-interstitial'
  /** Matched an error template observed elsewhere on the same host. */
  | 'origin-soft-404'
  /** Carries not-found markers, but no template for that host was observed. */
  | 'unverified-soft-404'
  /** A registrar or parking holding page captured after the site died. */
  | 'parked-domain'
  /** A `meta refresh` or a scripted location assignment, with its target. */
  | 'meta-refresh-redirect'
  /** A frameset whose referenced frames hold no validated bytes here. */
  | 'frameset-only'
  /** A success status with a zero-length body. */
  | 'empty-body'
  /** A status that carried no usable body. */
  | 'http-error'
  /** The provider holds no capture: a 404 or 410 replay, or no known time. */
  | 'not-archived'
  /** The provider kept refusing within the retry budget. */
  | 'rate-limited'
  /** The connection or adapter failed before a response arrived. */
  | 'transport-error'
  /** The destination guard refused the URL or a redirect target. */
  | 'destination-refused'
  /** A redirect chain hit the hop limit or returned to a visited URL. */
  | 'redirect-unresolved'
  /** The body did not match the type the referring markup implied. */
  | 'content-type-mismatch'
  /** The body exceeded the per-response byte cap. */
  | 'oversized-body'
  /** No request happened. */
  | 'unattempted';

/** Every member of the closed set, for zero-filling per-outcome counts. */
export const ITEM_OUTCOMES: readonly ItemOutcome[] = [
  'ok',
  'archive-interstitial',
  'origin-soft-404',
  'unverified-soft-404',
  'parked-domain',
  'meta-refresh-redirect',
  'frameset-only',
  'empty-body',
  'http-error',
  'not-archived',
  'rate-limited',
  'transport-error',
  'destination-refused',
  'redirect-unresolved',
  'content-type-mismatch',
  'oversized-body',
  'unattempted',
];

/**
 * The failure axis projected onto the content axis.
 *
 * Typed as a total record, so adding a `FailureKind` without deciding what it
 * means for content is a compile error rather than a silent gap.
 */
export const OUTCOME_BY_FAILURE_KIND: Readonly<Record<FailureKind, ItemOutcome>> = {
  'destination-refused': 'destination-refused',
  'transport-error': 'transport-error',
  'provider-throttled': 'rate-limited',
  'redirect-limit': 'redirect-unresolved',
  'redirect-loop': 'redirect-unresolved',
  'http-status': 'http-error',
  'archive-error-page': 'archive-interstitial',
  'content-type-mismatch': 'content-type-mismatch',
  'empty-body': 'empty-body',
  'oversized-body': 'oversized-body',
};

/** Statuses that mean the provider holds no capture, rather than an error. */
const NOT_ARCHIVED_STATUSES = new Set([404, 410]);

/**
 * A failure's outcome, with one refinement the kind alone cannot carry: a
 * replay answered with 404 or 410 says the provider has no capture at that
 * URL, which is a different fact from an error while serving one.
 */
export function outcomeForFailure(value: Failure): ItemOutcome {
  if (value.kind === 'http-status' && value.httpStatus !== null && NOT_ARCHIVED_STATUSES.has(value.httpStatus)) {
    return 'not-archived';
  }
  return OUTCOME_BY_FAILURE_KIND[value.kind];
}

/** Every outcome at zero, so per-outcome counts are never sparse. */
export function zeroOutcomeCounts(): Record<ItemOutcome, number> {
  const counts = {} as Record<ItemOutcome, number>;
  for (const outcome of ITEM_OUTCOMES) counts[outcome] = 0;
  return counts;
}

/** Which axis decided the outcome, so a report can be audited. */
export type OutcomeSource = 'unattempted' | 'no-capture' | 'failure' | 'content';

export interface OutcomeRecord {
  outcome: ItemOutcome;
  source: OutcomeSource;
  /** Why this outcome, in one line. Never a body excerpt. */
  detail: string;
  /** Set only for `meta-refresh-redirect`: the resolved redirect target. */
  redirectTarget: string | null;
  /** Set only for `origin-soft-404`: the observed template that matched. */
  matchedTemplate: string | null;
  /** True only for `ok`. M2 selects references from these and nothing else. */
  referenceEligible: boolean;
}

export function outcomeRecord(
  outcome: ItemOutcome,
  source: OutcomeSource,
  detail: string,
  options: { redirectTarget?: string | null; matchedTemplate?: string | null } = {},
): OutcomeRecord {
  return {
    outcome,
    source,
    detail,
    redirectTarget: options.redirectTarget ?? null,
    matchedTemplate: options.matchedTemplate ?? null,
    referenceEligible: outcome === 'ok',
  };
}
