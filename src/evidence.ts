/**
 * The portable evidence report.
 *
 * Four states are named separately and never merged: indexed (the provider
 * said it exists), fetched (validated bytes arrived), failed (a request
 * happened and produced no usable bytes) and unattempted (no request
 * happened). A report that collapses those into one success ratio cannot be
 * audited.
 *
 * `recoveredFiles` is the strict subset with a stored body hash and a passed
 * validation. A discovered URL, an indexed row and a local path mapping are
 * none of them a recovered file.
 *
 * Portability means the report carries relative store paths and no operator
 * filesystem layout, no credentials and no private collection URLs
 * (agentic/contract.json, safety.private_material_excluded).
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BudgetSpend, Budgets } from './budget.ts';
import type { ProjectConfig } from './config.ts';
import {
  isComplete,
  promotableAsReference,
  referenceEligible,
  type ArchiveInjectionRecord,
  type AssetLookup,
  type EncodingRecord,
  type JobState,
  type RedirectHop,
  type TimelineEntry,
  type WorkItem,
} from './job.ts';
import type { AssetCaptureSource, DigestObservation } from './resolve-asset.ts';
import { captureDistanceSeconds, expandTimestamp } from './wayback.ts';
import type { CaptureSelection } from './select.ts';
import { zeroOutcomeCounts, type Failure, type ItemOutcome, type OutcomeRecord, type UnattemptedReason } from './outcomes.ts';
import { weakestSignal, type FidelityBand, type FidelityScore } from './fidelity.ts';

export const EVIDENCE_FILE = 'evidence.json';
/**
 * 3 added the per-asset capture resolution section (issue #6).
 * 4 added the fidelity section and the per-file fidelity digest (issue #8).
 *
 * The job state version is deliberately *not* bumped alongside it. A version 3
 * job carries no `fidelity` on its items, and that is a visible absence rather
 * than a wrong number: it reports zero scored pages, and one `reclassify` run
 * fills it in from bytes already stored, for zero requests. The 2 to 3 bump
 * was different in kind, because a version 2 job would have reported every
 * asset as having zero captures, which reads as a fact rather than a gap.
 */
export const EVIDENCE_SCHEMA_VERSION = 4;

export interface IndexedEntry {
  originalUrl: string;
  kind: string;
  relation: string;
  requestedTimestamp: string | null;
  alternatives: string[];
  /** Which policy chose the requested capture, and why. */
  selection: CaptureSelection | null;
  archiveDigest: string | null;
  discoveredFrom: string | null;
}

export interface FetchedEntry {
  originalUrl: string;
  localPath: string;
  requestUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  redirectChain: RedirectHop[];
  requestedTimestamp: string | null;
  servedTimestamp: string | null;
  captureDistanceSeconds: number | null;
  replayModifier: string;
  attempts: number;
  /** The stored body's length. Bytes charged to the budget are separate. */
  bodyLength: number;
  bytesRead: number;
  bodyHash: string | null;
  storePath: string | null;
  contentType: string | null;
  encoding: EncodingRecord | null;
  /** What the defensive archive-injection strip found in these bytes. */
  archiveInjection: ArchiveInjectionRecord | null;
  outcome: OutcomeRecord | null;
}

export interface FailedEntry {
  originalUrl: string;
  requestUrl: string | null;
  finalUrl: string | null;
  failure: Failure;
  attempts: number;
  redirectChain: RedirectHop[];
  /** Bytes may have arrived and been retained even though nothing validated. */
  bodyHash: string | null;
  outcome: OutcomeRecord | null;
}

export interface UnattemptedEntry {
  originalUrl: string;
  kind: string;
  relation: string;
  reason: UnattemptedReason;
  discoveredFrom: string | null;
  notes: string[];
  outcome: OutcomeRecord | null;
}

export interface RecoveredFile {
  originalUrl: string;
  localPath: string;
  bodyHash: string;
  byteLength: number;
  storePath: string;
  contentType: string | null;
  servedTimestamp: string | null;
  /**
   * Validated bytes are not by themselves recovered content. Only an `ok`
   * outcome may become an M2 reference; everything else stays here as
   * evidence of what the provider served.
   */
  outcome: ItemOutcome | null;
  referenceEligible: boolean;
  /**
   * The graded verdict (issue #8), or null when nothing was scored. It never
   * contradicts `referenceEligible` above: it exists only for files that are
   * already eligible, and it can only narrow them.
   */
  fidelity: FidelityDigest | null;
}

/** The score in one line. The full breakdown lives in `fidelity.scored`. */
export interface FidelityDigest {
  score: number;
  band: FidelityBand;
  promotionBlocked: boolean;
  overridden: boolean;
}

/**
 * One dependency, resolved against its own captures rather than against the
 * timestamp of the page that referenced it (issue #6).
 *
 * Both distances are kept. `deltaSeconds` is the distance the resolver chose,
 * and `servedDeltaSeconds` is the distance that actually arrived: a replay
 * redirect can land on a neighbouring capture, and an asset can therefore be
 * acquired from further away than it was resolved to.
 */
export interface AssetResolutionEntry {
  originalUrl: string;
  localPath: string;
  referringPageUrl: string;
  referringTimestamp: string | null;
  /** The capture the resolver asked for. */
  resolvedTimestamp: string | null;
  /** The capture the provider actually served. Null until bytes arrive. */
  servedTimestamp: string | null;
  deltaSeconds: number | null;
  servedDeltaSeconds: number | null;
  windowDays: number;
  /** The acquired capture lies outside the documented window. */
  temporallyDistant: boolean;
  source: AssetCaptureSource;
  candidateCount: number;
  /** Every distinct content hash this URL served across its captures. */
  distinctDigests: DigestObservation[];
  /** The provider's digest for the chosen capture. */
  archiveDigest: string | null;
  /** The local SHA-256 of the bytes that arrived. Null when none did. */
  bodyHash: string | null;
  status: string;
  /** Why this capture was chosen, in one line. */
  detail: string;
}

export type GapKind =
  | 'failed-fetch'
  | 'non-content-body'
  | 'unattempted'
  | 'no-capture'
  | 'degraded-encoding'
  | 'truncated-body'
  | 'capture-era-distance'
  | 'archive-injection'
  | 'excluded-capture-only'
  | 'temporally-distant-asset'
  | 'asset-content-drift'
  | 'low-fidelity'
  | 'partial-inventory';

export interface GapEntry {
  kind: GapKind;
  originalUrl: string;
  detail: string;
  /** A remedy a later milestone can act on, not an automatic action. */
  remedy: string;
}

export interface EvidenceReport {
  schemaVersion: number;
  projectId: string;
  generatedAt: string;
  runState: string;
  scope: JobState['scope'];
  budgets: Budgets;
  spend: BudgetSpend;
  inventory: {
    runs: JobState['inventoryRuns'];
    /**
     * Every CDX query string this job issued, verbatim and in order. A report
     * that does not say which query was asked cannot be audited for coverage.
     */
    queries: string[];
    /**
     * The acquisition-candidate rules applied locally to the returned rows.
     * They are not sent upstream, so excluded rows survive in `timeline`.
     */
    candidateFilters: string[];
    /**
     * Captures excluded from acquisition and kept as evidence of when a URL
     * moved or died. Excluded is not deleted.
     */
    timeline: TimelineEntry[];
    /** True when an index run stopped early, so the inventory is partial. */
    partial: boolean;
    /** Why the inventory is partial, when it is. Empty when it is complete. */
    partialReasons: string[];
  };
  /**
   * Per-asset capture resolution (issue #6): what each dependency was resolved
   * to, how far that is from the page that referenced it, and what the
   * resolution cost in index requests.
   */
  assets: {
    windowDays: number;
    resolved: AssetResolutionEntry[];
    /**
     * Per-URL index lookups issued, one per URL at most. An empty list means
     * every dependency was resolved from captures the inventory had already
     * returned, for no additional index request.
     */
    lookups: AssetLookup[];
    /** Index requests spent on per-asset resolution, retries included. */
    lookupIndexRequests: number;
    /** Assets resolved from the inventory, for no additional index request. */
    resolvedFromInventory: number;
    /** Assets with no capture anywhere. Each one also raises a gap. */
    withoutCapture: number;
    temporallyDistant: number;
  };
  /**
   * Graded per-page fidelity (issue #8). Every signal is written out with its
   * weight and its contribution, so a reviewer can see which one moved a score
   * rather than being handed a composite to trust.
   */
  fidelity: {
    scored: FidelityScore[];
    counts: {
      scored: number;
      accept: number;
      acceptWithWarning: number;
      reviewRequired: number;
      /** Eligible on both axes: outcome `ok` and not blocked by the score. */
      promotable: number;
      /** Blocks lifted by an override recorded in project configuration. */
      overridden: number;
    };
  };
  counts: {
    items: number;
    indexed: number;
    fetched: number;
    failed: number;
    unattempted: number;
    skipped: number;
    recoveredFiles: number;
    /** The subset of recoveredFiles an M2 reference may be frozen from. */
    referenceEligible: number;
    /** Indexed captures retained as timeline evidence, never fetched. */
    timelineRows: number;
    /** Every outcome in the closed set, zero-filled. Sums to `items`. */
    byOutcome: Record<ItemOutcome, number>;
  };
  indexed: IndexedEntry[];
  fetched: FetchedEntry[];
  failed: FailedEntry[];
  unattempted: UnattemptedEntry[];
  recoveredFiles: RecoveredFile[];
  gaps: GapEntry[];
  events: JobState['events'];
}

/** A capture more than a year from the requested one is flagged, not dropped. */
export const ERA_DISTANCE_WARNING_SECONDS = 365 * 24 * 60 * 60;

export function buildEvidenceReport(state: JobState, config: ProjectConfig): EvidenceReport {
  const indexed: IndexedEntry[] = state.items.map((item) => ({
    originalUrl: item.originalUrl,
    kind: item.kind,
    relation: item.relation,
    requestedTimestamp: item.capture.requestedTimestamp,
    alternatives: item.capture.alternatives,
    selection: item.capture.selection,
    archiveDigest: item.capture.archiveDigest,
    discoveredFrom: item.discoveredFrom,
  }));

  const fetched: FetchedEntry[] = [];
  const failed: FailedEntry[] = [];
  const unattempted: UnattemptedEntry[] = [];
  const recoveredFiles: RecoveredFile[] = [];
  const gaps: GapEntry[] = [];
  const byOutcome = zeroOutcomeCounts();
  const assets: AssetResolutionEntry[] = [];
  const scored: FidelityScore[] = [];
  let skipped = 0;
  let eligible = 0;
  let promotable = 0;

  for (const item of state.items) {
    const resolution = item.capture.resolution;
    if (resolution !== null) {
      const servedDeltaSeconds =
        resolution.referringTimestamp === null || item.capture.servedTimestamp === null
          ? null
          : captureDistanceSeconds(
              expandTimestamp(resolution.referringTimestamp, 'start'),
              expandTimestamp(item.capture.servedTimestamp, 'start'),
            );
      // The flag follows the bytes that arrived, not only the capture that was
      // asked for: a replay redirect can land further out than the resolver
      // chose, and that is still an asset acquired from another era.
      const temporallyDistant =
        resolution.temporallyDistant ||
        (servedDeltaSeconds !== null && servedDeltaSeconds > resolution.windowDays * 86_400);

      assets.push({
        originalUrl: item.originalUrl,
        localPath: item.localPath,
        referringPageUrl: resolution.referringPageUrl,
        referringTimestamp: resolution.referringTimestamp,
        resolvedTimestamp: resolution.resolvedTimestamp,
        servedTimestamp: item.capture.servedTimestamp,
        deltaSeconds: resolution.deltaSeconds,
        servedDeltaSeconds,
        windowDays: resolution.windowDays,
        temporallyDistant,
        source: resolution.source,
        candidateCount: resolution.consideredCount,
        distinctDigests: resolution.distinctDigests,
        archiveDigest: item.capture.archiveDigest,
        bodyHash: item.fetch?.bodyHash ?? null,
        status: item.status,
        detail: resolution.detail,
      });

      if (temporallyDistant) {
        gaps.push({
          kind: 'temporally-distant-asset',
          originalUrl: item.originalUrl,
          detail:
            `acquired from ${item.capture.servedTimestamp ?? resolution.resolvedTimestamp ?? 'an unknown capture'}, ` +
            `${String(servedDeltaSeconds ?? resolution.deltaSeconds ?? 0)}s from the referring page ` +
            `${resolution.referringPageUrl} at ${resolution.referringTimestamp ?? 'an unknown time'}, ` +
            `outside the declared ${String(resolution.windowDays)}-day window`,
          remedy: 'accept the era difference explicitly, or narrow the window and record the asset as unavailable',
        });
      }

      // The asset URL served different content over its life, so which
      // capture was taken decides which image the rebuilt page shows.
      if (resolution.distinctDigests.length > 1) {
        gaps.push({
          kind: 'asset-content-drift',
          originalUrl: item.originalUrl,
          detail:
            `this URL served ${String(resolution.distinctDigests.length)} distinct content hashes ` +
            `(${resolution.distinctDigests
              .map((observation) => `${observation.digest}@${observation.timestamps.join(',')}`)
              .join('; ')}); ${resolution.detail}`,
          remedy: 'confirm the chosen capture is the content the referring page showed',
        });
      }
    }
    if (item.status === 'fetched' && item.fetch !== null) {
      fetched.push({
        originalUrl: item.originalUrl,
        localPath: item.localPath,
        requestUrl: item.fetch.requestUrl,
        finalUrl: item.fetch.finalUrl,
        httpStatus: item.fetch.httpStatus,
        redirectChain: item.fetch.redirectChain,
        requestedTimestamp: item.capture.requestedTimestamp,
        servedTimestamp: item.capture.servedTimestamp,
        captureDistanceSeconds: item.capture.distanceSeconds,
        replayModifier: item.capture.replayModifier,
        attempts: item.fetch.attempts,
        bodyLength: item.fetch.bodyLength,
        bytesRead: item.fetch.bytesRead,
        bodyHash: item.fetch.bodyHash,
        storePath: item.fetch.storePath,
        contentType: item.fetch.contentType,
        encoding: item.encoding,
        archiveInjection: item.fetch.archiveInjection,
        outcome: item.outcome,
      });
    }

    // Injected replay markup in acquired bytes means the replay modifier did
    // not do its job. The stripper caught it, and that is worth surfacing
    // rather than quietly absorbing: it is a signal about the provider.
    if ((item.fetch?.archiveInjection?.removedNodes ?? 0) > 0) {
      const injection = item.fetch?.archiveInjection;
      gaps.push({
        kind: 'archive-injection',
        originalUrl: item.originalUrl,
        detail:
          `the defensive strip removed ${String(injection?.removedNodes ?? 0)} archive-injected node(s) ` +
          `(${(injection?.rules ?? []).join(', ')}) from bytes fetched with ` +
          `${item.capture.replayModifier}`,
        remedy: 'confirm the replay modifier reached the provider; the stored bytes are not raw capture bytes',
      });
    }

    if (item.outcome !== null) byOutcome[item.outcome.outcome] += 1;

    // A blocked page and an overridden one both raise the gap. An override is
    // a recorded decision to proceed, never a reason to stop reporting.
    if (item.fidelity !== null) {
      scored.push(item.fidelity);
      if (item.fidelity.band === 'review-required') {
        const weakest = weakestSignal(item.fidelity);
        gaps.push({
          kind: 'low-fidelity',
          originalUrl: item.originalUrl,
          detail:
            `fidelity ${item.fidelity.score.toFixed(4)} is below the review-required threshold ` +
            `${String(item.fidelity.thresholds.acceptWithWarning)}; weakest signal ${weakest?.name ?? 'none'} ` +
            `at ${String(weakest?.value ?? 0)} (${weakest?.detail ?? 'no signal was measured'})` +
            (item.fidelity.override === null
              ? ''
              : `; promotion overridden by ${item.fidelity.override.recordedBy}: ${item.fidelity.override.reason}`),
          remedy:
            item.fidelity.override === null
              ? 'select an alternative capture, or record an explicit override before freezing this as a reference'
              : 'the override is recorded; confirm it still holds before freezing this as a reference',
        });
      }
    }

    if (isComplete(item) && item.fetch?.bodyHash != null && item.fetch.storePath != null) {
      const eligibleHere = referenceEligible(item);
      if (eligibleHere) eligible += 1;
      if (promotableAsReference(item)) promotable += 1;
      recoveredFiles.push({
        originalUrl: item.originalUrl,
        localPath: item.localPath,
        bodyHash: item.fetch.bodyHash,
        byteLength: item.fetch.bodyLength,
        storePath: item.fetch.storePath,
        contentType: item.fetch.contentType,
        servedTimestamp: item.capture.servedTimestamp,
        outcome: item.outcome?.outcome ?? null,
        referenceEligible: eligibleHere,
        fidelity:
          item.fidelity === null
            ? null
            : {
                score: item.fidelity.score,
                band: item.fidelity.band,
                promotionBlocked: item.fidelity.promotionBlocked,
                overridden: item.fidelity.override !== null,
              },
      });

      // Validated bytes that are not content are the silent failure issue #5
      // exists to stop. They stay stored and named, and they are named here so
      // the gap report is where a reviewer sees them.
      if (!eligibleHere) {
        gaps.push({
          kind: 'non-content-body',
          originalUrl: item.originalUrl,
          detail: `${item.outcome?.outcome ?? 'unclassified'}: ${
            item.outcome?.detail ?? 'no classification pass has run'
          }`,
          remedy: 'select an alternative capture; this body must not become a reference',
        });
      }
    }

    if (item.status === 'failed' && item.failure !== null) {
      failed.push({
        originalUrl: item.originalUrl,
        requestUrl: item.fetch?.requestUrl ?? null,
        finalUrl: item.fetch?.finalUrl ?? null,
        failure: item.failure,
        attempts: item.fetch?.attempts ?? 0,
        redirectChain: item.fetch?.redirectChain ?? [],
        bodyHash: item.fetch?.bodyHash ?? null,
        outcome: item.outcome,
      });
      gaps.push({
        kind: 'failed-fetch',
        originalUrl: item.originalUrl,
        detail: `${item.failure.kind}: ${item.failure.message}`,
        remedy: item.failure.retryable
          ? 'resume the job with retry enabled, or select an alternative capture'
          : 'select an alternative capture or record the item as unavailable',
      });
    }

    // The only captures of this URL are ones the origin answered with a
    // redirect or an error. The bytes are worth having, the outcome pass will
    // say what they are, and they are never quietly treated as the page.
    if (item.capture.selection?.fromExcludedCapture === true) {
      gaps.push({
        kind: 'excluded-capture-only',
        originalUrl: item.originalUrl,
        detail: `every indexed capture failed the candidate filter; acquired ${
          item.capture.requestedTimestamp ?? 'an unknown capture'
        } with archive status ${item.capture.archiveStatus ?? 'unknown'}`,
        remedy: 'widen the inventory period to look for a capture the origin answered normally',
      });
    }

    if (item.status === 'unattempted') {
      const reason = item.unattemptedReason ?? 'queued';
      unattempted.push({
        originalUrl: item.originalUrl,
        kind: item.kind,
        relation: item.relation,
        reason,
        discoveredFrom: item.discoveredFrom,
        notes: item.notes,
        outcome: item.outcome,
      });
      gaps.push({
        kind: 'unattempted',
        originalUrl: item.originalUrl,
        detail: `no request was made: ${reason}`,
        remedy: reason === 'budget-exhausted' ? 'raise the declared budget and resume' : 'resume the job',
      });
    }

    if (item.status === 'skipped') {
      skipped += 1;
      gaps.push({
        kind: 'no-capture',
        originalUrl: item.originalUrl,
        detail: item.notes.join('; ') || 'no capture is known for this URL',
        remedy: 'widen the inventory period or supply the file from another source',
      });
    }

    if (item.encoding?.degraded === true) {
      gaps.push({
        kind: 'degraded-encoding',
        originalUrl: item.originalUrl,
        detail: `replacement ratio ${item.encoding.replacementRatio.toFixed(4)} exceeds ${String(
          item.encoding.replacementThreshold,
        )} under ${item.encoding.chosenEncoding ?? 'an unresolved encoding'}`,
        remedy: 'review the chosen encoding before this body is used as a reference',
      });
    }

    if (item.fetch?.truncated === true) {
      gaps.push({
        kind: 'truncated-body',
        originalUrl: item.originalUrl,
        detail: `body hit the response byte cap at ${item.fetch.bytesRead} bytes`,
        remedy: 'raise maxResponseBytes and re-acquire this item',
      });
    }

    if (
      item.capture.distanceSeconds !== null &&
      item.capture.distanceSeconds > ERA_DISTANCE_WARNING_SECONDS
    ) {
      gaps.push({
        kind: 'capture-era-distance',
        originalUrl: item.originalUrl,
        detail: `served capture ${item.capture.servedTimestamp ?? 'unknown'} is ${String(
          item.capture.distanceSeconds,
        )}s from the requested ${item.capture.requestedTimestamp ?? 'unknown'}`,
        remedy: 'choose a capture inside the declared period before freezing a reference',
      });
    }
  }

  const partialReasons = inventoryPartialReasons(state);
  if (partialReasons.length > 0) {
    gaps.push({
      kind: 'partial-inventory',
      originalUrl: state.scope.url,
      detail: partialReasons.join('; '),
      remedy: 'resume the job, or raise the page and index-request budgets, before treating this inventory as the whole site',
    });
  }

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    projectId: config.projectId,
    generatedAt: state.updatedAt,
    runState: state.runState,
    scope: state.scope,
    budgets: state.budgets,
    spend: state.spend,
    inventory: {
      runs: state.inventoryRuns,
      queries: state.inventoryRuns.map((run) => run.requestUrl),
      candidateFilters: [...new Set(state.inventoryRuns.flatMap((run) => run.candidateFilters))],
      timeline: state.timeline,
      partial: partialReasons.length > 0,
      partialReasons,
    },
    assets: {
      windowDays: config.assetResolution.windowDays,
      resolved: assets,
      lookups: state.assetLookups,
      lookupIndexRequests: state.assetLookups.reduce((total, lookup) => total + lookup.attempts, 0),
      resolvedFromInventory: assets.filter((entry) => entry.source === 'inventory').length,
      withoutCapture: assets.filter((entry) => entry.resolvedTimestamp === null).length,
      temporallyDistant: assets.filter((entry) => entry.temporallyDistant).length,
    },
    fidelity: {
      scored,
      counts: {
        scored: scored.length,
        accept: scored.filter((entry) => entry.band === 'accept').length,
        acceptWithWarning: scored.filter((entry) => entry.band === 'accept-with-warning').length,
        reviewRequired: scored.filter((entry) => entry.band === 'review-required').length,
        promotable,
        overridden: scored.filter((entry) => entry.override !== null).length,
      },
    },
    counts: {
      items: state.items.length,
      indexed: indexed.length,
      fetched: fetched.length,
      failed: failed.length,
      unattempted: unattempted.length,
      skipped,
      recoveredFiles: recoveredFiles.length,
      referenceEligible: eligible,
      timelineRows: state.timeline.length,
      byOutcome,
    },
    indexed,
    fetched,
    failed,
    unattempted,
    recoveredFiles,
    gaps,
    events: state.events,
  };
}

/**
 * Why an inventory may not be the whole site.
 *
 * A truncated inventory reported as complete is the failure this list exists
 * to prevent: it turns "we never asked" into "there was nothing there". A run
 * that filled its limit is suspect even when the provider returned no
 * continuation key, because nothing then proves the limit was not the cut.
 */
export function inventoryPartialReasons(state: JobState): string[] {
  const reasons: string[] = [];
  if (state.inventoryRuns.length === 0) {
    reasons.push('no inventory run was recorded');
    return reasons;
  }
  const last = state.inventoryRuns.at(-1);
  if (last?.outcome === 'continued') {
    reasons.push(`the last index run stopped with an unused continuation key (${last.id})`);
  }
  for (const run of state.inventoryRuns) {
    if (run.outcome === 'failed') reasons.push(`${run.id} failed: ${run.failure?.kind ?? 'unknown'}`);
    if (run.limitReached) {
      reasons.push(`${run.id} returned ${String(run.rowCount)} rows and filled its declared limit`);
    }
  }
  return reasons;
}

export async function writeEvidenceReport(directory: string, report: EvidenceReport): Promise<string> {
  const path = join(directory, EVIDENCE_FILE);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

/** One-screen summary for the CLI. Counts only; no body content is printed. */
export function summarize(report: EvidenceReport): string {
  const { counts, spend } = report;
  const lines = [
    `project        ${report.projectId}`,
    `run state      ${report.runState}`,
    `indexed        ${counts.indexed}`,
    `fetched        ${counts.fetched}`,
    `failed         ${counts.failed}`,
    `unattempted    ${counts.unattempted}`,
    `skipped        ${counts.skipped}`,
    `recovered      ${counts.recoveredFiles} files with validated bytes`,
    `eligible       ${counts.referenceEligible} of those may become an M2 reference`,
    `fidelity       ${report.fidelity.counts.scored} pages scored ` +
      `(${report.fidelity.counts.accept} accept, ${report.fidelity.counts.acceptWithWarning} with warning, ` +
      `${report.fidelity.counts.reviewRequired} review-required); ` +
      `${report.fidelity.counts.promotable} promotable, ${report.fidelity.counts.overridden} overridden`,
    `outcomes       ${outcomeLine(counts.byOutcome)}`,
    `assets         ${report.assets.resolved.length} resolved (${report.assets.resolvedFromInventory} from the inventory, ` +
      `${report.assets.lookups.length} per-URL lookups costing ${report.assets.lookupIndexRequests} index requests), ` +
      `${report.assets.withoutCapture} with no capture, ${report.assets.temporallyDistant} temporally distant`,
    `timeline       ${counts.timelineRows} non-candidate captures retained as evidence`,
    `gaps           ${report.gaps.length}`,
    `spend          ${spend.requests} requests (${spend.indexRequests} index), ${spend.bytes} bytes, ${spend.elapsedMs}ms`,
    `inventory      ${report.inventory.partial ? 'partial' : 'complete'}`,
  ];
  for (const reason of report.inventory.partialReasons) lines.push(`               ${reason}`);
  return lines.join('\n');
}

/** Non-zero outcome counts only, so the summary stays one screen. */
function outcomeLine(byOutcome: Record<ItemOutcome, number>): string {
  const present = Object.entries(byOutcome).filter(([, count]) => count > 0);
  if (present.length === 0) return 'none classified';
  return present.map(([outcome, count]) => `${outcome}=${String(count)}`).join(' ');
}

export function itemsByStatus(state: JobState): Record<string, WorkItem[]> {
  const grouped: Record<string, WorkItem[]> = { unattempted: [], fetched: [], failed: [], skipped: [] };
  for (const item of state.items) (grouped[item.status] ??= []).push(item);
  return grouped;
}
