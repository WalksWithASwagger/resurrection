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
import { isComplete, loadJob, saveJob, type JobState } from './job.ts';
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

  return {
    itemsClassified: state.items.length,
    storeReads: reads,
    missingBodies: missing,
    templates: [...context.templates.byHost.values()].flat(),
    counts,
  };
}

export interface ReclassifyResult {
  state: JobState;
  summary: ClassificationSummary;
}

/**
 * Reclassify a job already on disk. Opens no socket and refetches nothing.
 */
export async function reclassifyJob(directory: string): Promise<ReclassifyResult> {
  const state = await loadJob(directory);
  if (state === null) throw new Error(`no job found in ${directory}`);

  const summary = await classifyCollection(state, new BodyStore(join(directory, 'store')));
  await saveJob(directory, state);
  return { state, summary };
}
