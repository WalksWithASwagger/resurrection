/**
 * Classify, or reclassify, a whole collection from bytes already on disk.
 *
 * Classification is collection-wide: an origin soft 404 is recognised by
 * comparison against an error template observed elsewhere in the same
 * collection, and a frameset is empty only relative to what was actually
 * captured. So it runs as a pass over every item after the fetch loop, not
 * inside it.
 *
 * The pass reads bodies from the content-addressed store and re-decodes them
 * through `decode.ts`. There is no transport here and no second decoder:
 * reclassifying an existing collection costs zero requests, which is what
 * makes changing a marker list or a precedence rule a cheap, auditable
 * operation instead of a refetch (issues #4 and #5).
 *
 * Fidelity scoring (issue #8) runs in the same pass, over the same decoded
 * texts, immediately after classification. It has to run after, because a
 * score is only ever computed for an item issue #5 has already called `ok`,
 * and it runs here rather than in a second pass so that rescoring a whole
 * collection costs the same zero requests and one store read per body.
 */

import { join } from 'node:path';

import {
  buildErrorTemplateIndex,
  classifyItem,
  type ClassificationContext,
  type ErrorTemplate,
  type TemplateObservation,
} from './classify.ts';
import { decodeBody } from './decode.ts';
import {
  buildSegmentFrequency,
  scoreItem,
  DEFAULT_FIDELITY,
  type AssetSummary,
  type FidelityBand,
  type FidelityConfig,
  type FidelityContext,
} from './fidelity.ts';
import { isComplete, loadJob, saveJob, type JobState, type WorkItem } from './job.ts';
import { zeroOutcomeCounts, type ItemOutcome } from './outcomes.ts';
import { BodyStore } from './store.ts';

export interface ClassificationSummary {
  itemsClassified: number;
  /** Bodies read back from the store. No request can raise this number. */
  storeReads: number;
  /** Bodies whose stored bytes were gone, so no content check could run. */
  missingBodies: number;
  templates: ErrorTemplate[];
  counts: Record<ItemOutcome, number>;
  /** What the fidelity pass did, per band. Never a request. */
  fidelity: FidelitySummary;
}

export interface FidelitySummary {
  /** Pages that received a score. Every one of them has outcome `ok`. */
  scored: number;
  /** Items issue #5's gate excluded, so no score was computed. */
  gatedByOutcome: number;
  /**
   * `ok` items that are not a markup document, so there is no page to score: a
   * stylesheet, a script, an image, a PDF, or a body that decoded as binary.
   */
  nonMarkup: number;
  byBand: Record<FidelityBand, number>;
  /** Scored pages that may not be frozen as an M2 reference. */
  promotionBlocked: number;
  /** Blocks lifted by an override recorded in project configuration. */
  overridden: number;
}

export function zeroFidelitySummary(): FidelitySummary {
  return {
    scored: 0,
    gatedByOutcome: 0,
    nonMarkup: 0,
    byBand: { accept: 0, 'accept-with-warning': 0, 'review-required': 0 },
    promotionBlocked: 0,
    overridden: 0,
  };
}

/** Decoded text per item id, for bodies the store still holds. */
async function decodedTexts(
  state: JobState,
  store: BodyStore,
): Promise<{ texts: Map<string, string | null>; reads: number; missing: number }> {
  const texts = new Map<string, string | null>();
  let reads = 0;
  let missing = 0;

  for (const item of state.items) {
    const hash = item.fetch?.bodyHash ?? null;
    if (hash === null) continue;
    const bytes = await store.read(hash).catch(() => null);
    if (bytes === null) {
      missing += 1;
      continue;
    }
    reads += 1;
    const decoded = decodeBody(bytes, { contentType: item.fetch?.contentType ?? null });
    texts.set(item.id, decoded.kind === 'text' ? decoded.text : null);
  }
  return { texts, reads, missing };
}

/**
 * Give every item exactly one outcome, in place.
 *
 * Items that were never fetched and items whose stored body is gone are still
 * classified: the first from its unattempted reason or its failure, the second
 * from its failure or, lacking one, as validated-but-unreadable bytes.
 */
export async function classifyCollection(
  state: JobState,
  store: BodyStore,
  fidelityConfig: FidelityConfig = DEFAULT_FIDELITY,
): Promise<ClassificationSummary> {
  const { texts, reads, missing } = await decodedTexts(state, store);

  const observations: TemplateObservation[] = state.items.map((item) => ({
    originalUrl: item.originalUrl,
    archiveStatus: item.capture.archiveStatus ?? null,
    text: texts.get(item.id) ?? null,
  }));
  const context: ClassificationContext = {
    templates: buildErrorTemplateIndex(observations),
    capturedUrls: new Set(state.items.filter(isComplete).map((item) => item.originalUrl)),
  };

  const counts = zeroOutcomeCounts();
  for (const item of state.items) {
    item.outcome = classifyItem(
      {
        originalUrl: item.originalUrl,
        status: item.status,
        unattemptedReason: item.unattemptedReason,
        failure: item.failure,
        validated: item.fetch?.validated === true,
        text: texts.get(item.id) ?? null,
      },
      context,
    );
    counts[item.outcome.outcome] += 1;
  }

  const fidelity = scoreClassifiedCollection(state, texts, fidelityConfig, context.capturedUrls);

  return {
    itemsClassified: state.items.length,
    storeReads: reads,
    missingBodies: missing,
    templates: [...context.templates.byHost.values()].flat(),
    counts,
    fidelity,
  };
}

/**
 * Score every page the outcome pass called `ok`, in place.
 *
 * Boilerplate is defined by what repeats across the collection, so the segment
 * frequency is built over every decoded body the job holds rather than over
 * the scored subset: a site's navigation bar is no less its navigation bar for
 * appearing on a page that turned out to be a 404 template.
 */
function scoreClassifiedCollection(
  state: JobState,
  texts: ReadonlyMap<string, string | null>,
  config: FidelityConfig,
  capturedUrls: ReadonlySet<string>,
): FidelitySummary {
  const context: FidelityContext = {
    config,
    segmentFrequency: buildSegmentFrequency(
      [...texts.values()].filter((text): text is string => text !== null),
    ),
    capturedUrls,
  };

  const assetsByPage = assetSummariesByPage(state);
  const summary = zeroFidelitySummary();

  for (const item of state.items) {
    const text = texts.get(item.id) ?? null;
    item.fidelity = scoreItem(
      {
        originalUrl: item.originalUrl,
        relation: item.relation,
        outcome: item.outcome?.outcome ?? 'unattempted',
        text,
        replacementRatio: item.encoding?.replacementRatio ?? 0,
        captures: item.capture.candidates,
        chosenTimestamp: item.capture.servedTimestamp ?? item.capture.requestedTimestamp,
        assets: assetsByPage.get(item.originalUrl) ?? [],
      },
      context,
    );

    if (item.fidelity === null) {
      if (item.outcome?.outcome !== 'ok') summary.gatedByOutcome += 1;
      else summary.nonMarkup += 1;
      continue;
    }
    summary.scored += 1;
    summary.byBand[item.fidelity.band] += 1;
    if (item.fidelity.promotionBlocked) summary.promotionBlocked += 1;
    if (item.fidelity.override !== null) summary.overridden += 1;
  }

  return summary;
}

/** Each page's dependencies, keyed by the page whose markup referenced them. */
function assetSummariesByPage(state: JobState): Map<string, AssetSummary[]> {
  const byPage = new Map<string, AssetSummary[]>();
  for (const item of state.items) {
    const resolution = item.capture.resolution;
    if (resolution === null) continue;
    const summaries = byPage.get(resolution.referringPageUrl) ?? [];
    summaries.push(summaryFor(item));
    byPage.set(resolution.referringPageUrl, summaries);
  }
  return byPage;
}

function summaryFor(item: WorkItem): AssetSummary {
  const resolution = item.capture.resolution;
  return {
    originalUrl: item.originalUrl,
    resolved: resolution?.resolvedTimestamp != null,
    acquired: isComplete(item),
    temporallyDistant: resolution?.temporallyDistant === true,
  };
}

export interface ReclassifyResult {
  state: JobState;
  summary: ClassificationSummary;
}

/**
 * Reclassify and rescore a job already on disk. Opens no socket and refetches
 * nothing. The fidelity policy defaults to the documented one; a caller that
 * holds the project's configuration passes its block so recorded overrides and
 * non-default weights are applied.
 */
export async function reclassifyJob(
  directory: string,
  fidelityConfig: FidelityConfig = DEFAULT_FIDELITY,
): Promise<ReclassifyResult> {
  const state = await loadJob(directory);
  if (state === null) throw new Error(`no job found in ${directory}`);

  const summary = await classifyCollection(state, new BodyStore(join(directory, 'store')), fidelityConfig);
  await saveJob(directory, state);
  return { state, summary };
}
