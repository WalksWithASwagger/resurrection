/**
 * Capture selection policy.
 *
 * The inventory offers several captures per URL and the fetch loop can only
 * ask for one. Which one is a declared policy, not an accident of row order,
 * and the choice plus its reason is recorded per item so a reviewer can see
 * why a particular era was acquired (issue #7).
 *
 * Selection runs over the candidates the inventory already returned, so
 * changing the policy and re-selecting costs zero index requests. That is the
 * same property that makes reclassification cheap in src/reclassify.ts.
 */

import { expandTimestamp, timestampToEpochMs } from './wayback.ts';

export type CaptureSelectionPolicy = 'nearest' | 'earliest-largest';

export const CAPTURE_SELECTION_POLICIES: readonly CaptureSelectionPolicy[] = ['nearest', 'earliest-largest'];

export interface SelectionConfig {
  policy: CaptureSelectionPolicy;
  /**
   * Captures within this many days of the earliest candidate are treated as
   * one coherent cluster by `earliest-largest`.
   */
  clusterWindowDays: number;
}

/**
 * `nearest` is the default because it is the only policy that cannot silently
 * contradict the period the operator declared: it aims at the declared bound
 * and never drifts to an era the project did not ask for. `earliest-largest`
 * is the right choice for a fully dead site, where early captures are the
 * least link-rotted, but it ranks by body length, and treating length as a
 * completeness signal is a fidelity judgement that belongs to issue #8 rather
 * than to a default. docs/ACQUISITION.md records when to switch.
 */
export const DEFAULT_SELECTION: SelectionConfig = { policy: 'nearest', clusterWindowDays: 90 };

export interface CaptureCandidate {
  timestamp: string;
  digest: string | null;
  statusCode: string | null;
  mimetype: string | null;
  /** The provider's reported body length. Null when the row did not give one. */
  length: number | null;
  /**
   * The candidate filter this capture failed, or null when it passed. An
   * excluded capture is retained and is chosen only when a URL has no other.
   */
  excludedBy: string | null;
}

export interface CaptureSelection {
  timestamp: string;
  policy: CaptureSelectionPolicy;
  /** The instant `nearest` measured against. Null when no period is declared. */
  target: string | null;
  /** One line naming why this capture won, for the evidence report. */
  reason: string;
  consideredCount: number;
  /**
   * True when every capture of this URL failed the candidate filter, so the
   * bytes come from a capture the origin answered with a redirect or an error.
   */
  fromExcludedCapture: boolean;
}

/**
 * The instant a period-aware policy aims at: the end of the declared period
 * when there is one, otherwise its start. A project with no declared period
 * has no target and falls back to the latest capture on record.
 */
export function selectionTarget(scope: { from: string | null; to: string | null }): string | null {
  if (scope.to !== null && scope.to !== '') return expandTimestamp(scope.to, 'end');
  if (scope.from !== null && scope.from !== '') return expandTimestamp(scope.from, 'start');
  return null;
}

export function selectCapture(
  candidates: readonly CaptureCandidate[],
  selection: SelectionConfig,
  target: string | null,
): CaptureSelection | null {
  const usable = candidates.filter((candidate) => /^\d{4,14}$/.test(candidate.timestamp));
  if (usable.length === 0) return null;

  // The filter ranks captures inside a URL. Only when it leaves nothing does
  // the excluded set come back into play, and then the selection says so.
  const eligible = usable.filter((candidate) => candidate.excludedBy === null);
  const fromExcludedCapture = eligible.length === 0;
  const pool = fromExcludedCapture ? usable : eligible;

  const chosen =
    selection.policy === 'earliest-largest'
      ? earliestLargest(pool, selection.clusterWindowDays)
      : nearest(pool, target);

  return {
    timestamp: chosen.candidate.timestamp,
    policy: selection.policy,
    target: selection.policy === 'nearest' ? target : null,
    reason: fromExcludedCapture
      ? `${chosen.reason}; every capture of this URL failed ${chosen.candidate.excludedBy ?? 'the candidate filter'}, so an excluded capture was taken`
      : chosen.reason,
    consideredCount: pool.length,
    fromExcludedCapture,
  };
}

interface Choice {
  candidate: CaptureCandidate;
  reason: string;
}

function nearest(candidates: readonly CaptureCandidate[], target: string | null): Choice {
  if (target === null) {
    const latest = [...candidates].sort(compareByTimestampDescending)[0] as CaptureCandidate;
    return { candidate: latest, reason: 'latest capture on record; the project declares no period to aim at' };
  }

  const targetEpoch = timestampToEpochMs(target);
  if (targetEpoch === null) {
    const latest = [...candidates].sort(compareByTimestampDescending)[0] as CaptureCandidate;
    return { candidate: latest, reason: `declared bound ${target} is not a usable instant; took the latest capture` };
  }

  let best = candidates[0] as CaptureCandidate;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const epoch = timestampToEpochMs(expandTimestamp(candidate.timestamp, 'start'));
    if (epoch === null) continue;
    const distance = Math.abs(epoch - targetEpoch);
    if (distance < bestDistance || (distance === bestDistance && outranks(candidate, best))) {
      best = candidate;
      bestDistance = distance;
    }
  }

  const seconds = Number.isFinite(bestDistance) ? Math.round(bestDistance / 1000) : null;
  return {
    candidate: best,
    reason:
      seconds === null
        ? `nearest usable capture to the declared bound ${target}`
        : `nearest to the declared bound ${target}, ${String(seconds)}s away`,
  };
}

/**
 * The largest body among the captures clustered around the earliest one.
 *
 * Early captures of a site that later died are the least link-rotted, and
 * inside one cluster the largest body is the most complete rendering rather
 * than a stub, a placeholder or a parking page. Both halves matter: earliest
 * alone can land on a one-line placeholder, largest alone can land years late.
 */
function earliestLargest(candidates: readonly CaptureCandidate[], clusterWindowDays: number): Choice {
  const ordered = [...candidates].sort(compareByTimestampAscending);
  const earliest = ordered[0] as CaptureCandidate;
  const earliestEpoch = timestampToEpochMs(expandTimestamp(earliest.timestamp, 'start'));
  const windowMs = clusterWindowDays * 24 * 60 * 60 * 1000;

  const cluster = ordered.filter((candidate) => {
    if (earliestEpoch === null) return candidate === earliest;
    const epoch = timestampToEpochMs(expandTimestamp(candidate.timestamp, 'start'));
    return epoch !== null && epoch - earliestEpoch <= windowMs;
  });

  let best = cluster[0] as CaptureCandidate;
  for (const candidate of cluster) {
    if ((candidate.length ?? -1) > (best.length ?? -1)) best = candidate;
  }

  return {
    candidate: best,
    reason:
      `largest of the ${String(cluster.length)} capture(s) within ${String(clusterWindowDays)} days of the ` +
      `earliest (${earliest.timestamp}), at ${best.length === null ? 'an unreported length' : `${String(best.length)} bytes`}`,
  };
}

/** Ties break toward the larger body, then the later capture. */
function outranks(candidate: CaptureCandidate, incumbent: CaptureCandidate): boolean {
  const size = (candidate.length ?? -1) - (incumbent.length ?? -1);
  if (size !== 0) return size > 0;
  return candidate.timestamp > incumbent.timestamp;
}

function compareByTimestampAscending(a: CaptureCandidate, b: CaptureCandidate): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

function compareByTimestampDescending(a: CaptureCandidate, b: CaptureCandidate): number {
  return -compareByTimestampAscending(a, b);
}
