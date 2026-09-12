/**
 * Typed terminal states for one work item.
 *
 * The sets here are closed on purpose. A new state is a deliberate change with
 * a fixture behind it, not an open-ended string. Issue #5 generalizes these
 * into a full outcome taxonomy; it should extend this union and the work-item
 * record rather than adding a parallel status field.
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
