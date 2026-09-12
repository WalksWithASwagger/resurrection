/**
 * Per-asset capture resolution.
 *
 * A dependency is not a copy of the page that referenced it. An image linked
 * from a 1999 page may have no 1999 capture at all while a perfectly good one
 * exists from 2001, and the same asset URL may have been reused for different
 * content over a site's life. Requesting a dependency at its referring page's
 * timestamp records the first case as missing and silently substitutes the
 * wrong bytes in the second (issue #6).
 *
 * So each asset is resolved against its own captures, and the target is the
 * referring page rather than the project's declared period bound. That is the
 * one difference from page selection (issue #7): the machinery in
 * `src/select.ts` is shared, the target is parameterised.
 *
 * Everything here is pure. Resolution runs over candidates the caller already
 * holds, which is what makes resolving an asset the domain inventory already
 * described cost zero index requests.
 */

import { selectCapture, type CaptureCandidate, type CaptureSelection } from './select.ts';
import { captureDistanceSeconds, expandTimestamp } from './wayback.ts';

export interface AssetResolutionConfig {
  /**
   * How far from the referring page a capture may be before it is flagged.
   *
   * It is a declaration threshold, not a filter. A capture outside the window
   * is still acquired and still recorded, because it is often the only
   * surviving copy of the asset; it is flagged `temporallyDistant` so nothing
   * downstream can treat it as contemporaneous with the page.
   */
  windowDays: number;
}

export const DEFAULT_ASSET_RESOLUTION: AssetResolutionConfig = { windowDays: 365 };

/** Where the candidate captures came from, and what their absence proves. */
export type AssetCaptureSource =
  /** The domain inventory already described this URL. Costs no request. */
  | 'inventory'
  /** A per-URL index lookup was issued because the inventory did not. */
  | 'targeted-lookup'
  /** No capture of this URL is known from either. */
  | 'none';

/**
 * One content hash the provider holds for this URL, with the captures that
 * carry it. More than one entry means the URL served different content over
 * its life, which is the failure that makes nearest-in-time selection matter.
 */
export interface DigestObservation {
  digest: string;
  timestamps: string[];
}

export interface AssetResolution {
  /** The page whose markup referenced this asset. */
  referringPageUrl: string;
  /** The capture time of that page. */
  referringTimestamp: string | null;
  source: AssetCaptureSource;
  /** The shared selection record, aimed at the referring page. */
  selection: CaptureSelection | null;
  /** The capture the resolver chose, or null when there is none to choose. */
  resolvedTimestamp: string | null;
  /** Referring page to chosen capture, in seconds. Null when either is unknown. */
  deltaSeconds: number | null;
  windowDays: number;
  /** The chosen capture lies outside the documented window. */
  temporallyDistant: boolean;
  consideredCount: number;
  /** Every distinct content hash across the captures of this URL. */
  distinctDigests: DigestObservation[];
  /** One line naming why this capture was chosen, for the evidence report. */
  detail: string;
}

export interface AssetResolutionInput {
  referringPageUrl: string;
  referringTimestamp: string | null;
  candidates: readonly CaptureCandidate[];
  source: AssetCaptureSource;
  /** Passed through to the shared selector so one policy record is produced. */
  clusterWindowDays: number;
  windowDays: number;
  /** Why no capture is known, when none is. Reported verbatim. */
  absenceDetail?: string;
}

export function resolveAssetCapture(input: AssetResolutionInput): AssetResolution {
  const target = input.referringTimestamp === null ? null : expandTimestamp(input.referringTimestamp, 'start');
  const digests = distinctDigests(input.candidates);

  const selection =
    input.candidates.length === 0
      ? null
      : selectCapture(input.candidates, { policy: 'nearest', clusterWindowDays: input.clusterWindowDays }, target);

  if (selection === null) {
    return {
      referringPageUrl: input.referringPageUrl,
      referringTimestamp: input.referringTimestamp,
      source: input.candidates.length === 0 ? input.source : 'none',
      selection: null,
      resolvedTimestamp: null,
      deltaSeconds: null,
      windowDays: input.windowDays,
      temporallyDistant: false,
      consideredCount: 0,
      distinctDigests: digests,
      detail:
        input.absenceDetail ??
        `no capture of this URL is known, so it stays unresolved rather than pointing at the live web`,
    };
  }

  const deltaSeconds =
    target === null ? null : captureDistanceSeconds(target, expandTimestamp(selection.timestamp, 'start'));
  const temporallyDistant = deltaSeconds !== null && deltaSeconds > input.windowDays * 86_400;

  return {
    referringPageUrl: input.referringPageUrl,
    referringTimestamp: input.referringTimestamp,
    source: input.source,
    selection,
    resolvedTimestamp: selection.timestamp,
    deltaSeconds,
    windowDays: input.windowDays,
    temporallyDistant,
    consideredCount: selection.consideredCount,
    distinctDigests: digests,
    detail: describe(selection, input, deltaSeconds, temporallyDistant, digests),
  };
}

function describe(
  selection: CaptureSelection,
  input: AssetResolutionInput,
  deltaSeconds: number | null,
  temporallyDistant: boolean,
  digests: readonly DigestObservation[],
): string {
  const from =
    input.source === 'inventory'
      ? 'from the captures the site inventory already returned'
      : 'from a per-URL index lookup';
  const distance =
    deltaSeconds === null
      ? 'an unmeasurable distance from'
      : `${formatDays(deltaSeconds)} from`;
  const drift =
    digests.length > 1
      ? `; this URL served ${String(digests.length)} distinct content hashes over its life, so the nearest capture is the one the page referenced`
      : '';
  const flag = temporallyDistant
    ? `; outside the ${String(input.windowDays)}-day window, so it is flagged temporally distant`
    : '';
  return (
    `chose capture ${selection.timestamp} ${from}, ${distance} the referring page ` +
    `${input.referringTimestamp ?? 'of unknown time'} out of ${String(selection.consideredCount)} candidate(s)${drift}${flag}`
  );
}

function formatDays(seconds: number): string {
  const days = seconds / 86_400;
  if (days < 1) return `${String(seconds)}s`;
  return `${days.toFixed(1)}d`;
}

function distinctDigests(candidates: readonly CaptureCandidate[]): DigestObservation[] {
  const byDigest = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.digest === null || candidate.digest === '') continue;
    const timestamps = byDigest.get(candidate.digest);
    if (timestamps === undefined) byDigest.set(candidate.digest, [candidate.timestamp]);
    else timestamps.push(candidate.timestamp);
  }
  return [...byDigest].map(([digest, timestamps]) => ({ digest, timestamps }));
}

/**
 * The key an asset URL is indexed under.
 *
 * The provider's `original` column and a URL resolved out of markup describe
 * the same capture in slightly different spellings, and a lookup that missed
 * because of a trailing slash would issue a request the inventory had already
 * answered. Fragments never reach the provider and are dropped.
 */
export function captureKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
