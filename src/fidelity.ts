/**
 * A graded fidelity score, computed from signals that already exist.
 *
 * M3's acceptance checks pass or fail a page family, which is the right gate
 * but says nothing about degree and runs late. Between acquisition and
 * generation there is nothing that says "this page is a stub, not an article",
 * so weak material can reach M2 and be frozen as a reference (issue #8).
 *
 * Everything here is pure and deterministic: the same stored bytes and the
 * same collection context always produce the same score. No model call, no
 * clock, no I/O, no network, and no confidence value that anything reported
 * about itself. `src/reclassify.ts` supplies the decoded text by re-reading
 * stored bytes, so rescoring a whole collection costs zero requests.
 *
 * Archived markup is untrusted data. Segments, titles and links are measured;
 * none of them is executed, followed or read for meaning
 * (agentic/contract.json, safety.archived_content_is_data).
 *
 * ## How this composes with issue #5
 *
 * `src/outcomes.ts` holds the single point of truth about whether an item
 * carries recovered content: `referenceEligible: outcome === 'ok'`. That rule
 * is unchanged and it wins. This module never widens it and never introduces a
 * second eligibility field:
 *
 *   - An item whose outcome is not `ok` is never scored at all. `scoreItem`
 *     returns null, so there is no number to argue with the outcome.
 *   - A score can only *narrow* promotion, through `promotionBlocked`, and
 *     `job.ts`'s `promotableAsReference` is literally `referenceEligible(item)
 *     && !promotionBlocked`.
 *   - An operator override in project configuration can lift the fidelity
 *     block. It can never lift the outcome gate.
 *
 * ## Why the outcome is the gate and not a weighted term
 *
 * Six signals were named when this was written. Five of them are weighted
 * below. The outcome is not, because inside the scored population it is
 * constant `ok` by construction: a weighted term that every scored page scores
 * identically on contributes nothing but a decorative constant. It is read,
 * and what it decides is whether a score exists.
 */

import { discoverLinks, type LinkRelation } from './discover.ts';
import type { ItemOutcome } from './outcomes.ts';
import type { CaptureCandidate } from './select.ts';
import { expandTimestamp, timestampToEpochMs } from './wayback.ts';

/* -------------------------------------------------------------------------- */
/* configuration                                                               */
/* -------------------------------------------------------------------------- */

export type FidelitySignalName = 'structure' | 'boilerplate' | 'encoding' | 'assets' | 'cross-capture';

export const FIDELITY_SIGNALS: readonly FidelitySignalName[] = [
  'structure',
  'boilerplate',
  'encoding',
  'assets',
  'cross-capture',
];

export type FidelityWeights = Readonly<Record<FidelitySignalName, number>>;

/**
 * Defaults, and why each one sits where it does.
 *
 * Ordering is the claim, not the exact decimals. Structure ranks highest
 * because it is the one signal that asks whether this is a page at all.
 * Boilerplate and the replacement ratio tie behind it, because they are two
 * ways of failing at the same thing: a page made of other pages' words and a
 * page whose own words are unreadable both yield no usable prose. Assets rank
 * lower because a missing image is a recorded gap rather than a reason to
 * distrust the text, and every one of them is already named in the gap report.
 * Cross-capture agreement is lowest because it is binary by construction (see
 * `crossCaptureAgreement`) and can corroborate without ever refuting.
 *
 * The composite is a weighted mean over the signals that could be measured, so
 * these need not sum to one and changing any one of them changes the score of
 * any page whose measured signals are not all equal. docs/FIDELITY.md records
 * the distribution they were calibrated against and how to change them.
 */
export const DEFAULT_FIDELITY_WEIGHTS: FidelityWeights = {
  structure: 0.3,
  boilerplate: 0.25,
  encoding: 0.25,
  assets: 0.15,
  'cross-capture': 0.1,
};

export type FidelityBand = 'accept' | 'accept-with-warning' | 'review-required';

export interface FidelityThresholds {
  /** At or above this, the page is accepted. */
  accept: number;
  /** At or above this, accepted with a recorded warning. Below it, review. */
  acceptWithWarning: number;
}

/**
 * Where the bands cut, and why not at the obvious halfway point.
 *
 * A weighted mean of these signals does not bottom out at zero for a bad page,
 * because several of them measure *damage* rather than merit. A placeholder
 * that happens to be cleanly encoded, references nothing and sits next to an
 * identical adjacent capture scores full marks on three of five signals while
 * carrying eleven characters of its own text. Cut the bands at a half and that
 * page reads as acceptable, which is exactly how a composite comes to rank
 * garbage highly.
 *
 * So the cut sits high. Against the distribution in docs/FIDELITY.md a clean
 * content page lands between 0.86 and 1.0, while a clean placeholder that is
 * merely undamaged lands near 0.61 and a bare stub near 0.46.
 * `review-required` therefore begins below 0.7, not below 0.5. That table is
 * what these were calibrated against, so moving them is an argument about
 * evidence rather than a preference.
 */
export const DEFAULT_FIDELITY_THRESHOLDS: FidelityThresholds = { accept: 0.85, acceptWithWarning: 0.7 };

export interface FidelityTuning {
  /** The replacement-character ratio at which the encoding signal reaches 0. */
  encodingZeroRatio: number;
  /** Visible body characters at which the length sub-check reaches 1. */
  bodyTextTarget: number;
  /** A text segment on at least this many pages is collection boilerplate. */
  boilerplateMinDocuments: number;
  /** Unique-text share at or below which the boilerplate signal is 0. */
  boilerplateZeroRatio: number;
  /** Unique-text share at or above which the boilerplate signal is 1. */
  boilerplateFullRatio: number;
}

export const DEFAULT_FIDELITY_TUNING: FidelityTuning = {
  encodingZeroRatio: 0.05,
  bodyTextTarget: 400,
  boilerplateMinDocuments: 2,
  boilerplateZeroRatio: 0.1,
  boilerplateFullRatio: 0.5,
};

/**
 * An operator's recorded decision to promote a page the score would block.
 *
 * It is a declaration in project configuration, so it is reviewable in a diff
 * and reproducible from the repository rather than being a runtime gesture
 * nothing records. It lifts the fidelity block and nothing else: an item whose
 * outcome is not `ok` is not scored, so there is no block here to override.
 */
export interface FidelityOverride {
  originalUrl: string;
  reason: string;
  recordedBy: string;
}

export interface FidelityConfig {
  weights: FidelityWeights;
  thresholds: FidelityThresholds;
  tuning: FidelityTuning;
  overrides: FidelityOverride[];
}

export const DEFAULT_FIDELITY: FidelityConfig = {
  weights: DEFAULT_FIDELITY_WEIGHTS,
  thresholds: DEFAULT_FIDELITY_THRESHOLDS,
  tuning: DEFAULT_FIDELITY_TUNING,
  overrides: [],
};

/**
 * How much of the asset signal one dependency earns.
 *
 * A documented table rather than four literals buried in a reducer. The shape
 * of the claim: no capture anywhere is the worst case because nothing can fix
 * it locally; a resolved capture whose bytes never arrived is nearly as bad
 * but is a retry away; a capture from another era is real content shown at the
 * wrong date, which is a fidelity cost rather than a loss.
 */
export const ASSET_CREDIT = {
  unresolved: 0,
  resolvedNotAcquired: 0.25,
  temporallyDistant: 0.6,
  acquired: 1,
} as const;

/* -------------------------------------------------------------------------- */
/* records                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One measured signal.
 *
 * `value`, `weight` and `contribution` are all written out rather than only
 * the composite, so a reviewer can see which signal moved a score instead of
 * being handed a number to trust. `measurements` carries the counts the value
 * was derived from. Neither ever carries body text.
 */
export interface FidelitySignal {
  name: FidelitySignalName;
  /**
   * 0 to 1, or null when this signal could not be measured for this page.
   *
   * Null is not zero and it is not one. A page that references no dependency
   * has no asset completeness to measure, and awarding it a free 1 would hand
   * every stub a quarter of a point it did not earn. An unmeasured signal is
   * dropped from the weighted mean instead, and `weight` below still says what
   * it would have counted for.
   */
  value: number | null;
  weight: number;
  /** `value * weight`, or 0 when unmeasured. Divided by the applied weight. */
  contribution: number;
  /** What was measured, or why it could not be, in one line. */
  detail: string;
  measurements: Record<string, number | string | boolean | null>;
}

export type CrossCaptureState =
  /** The inventory knows one capture of this URL, so there is nothing to compare. */
  | 'single-capture'
  /** An adjacent capture carries the same provider digest: identical bytes. */
  | 'identical'
  /** An adjacent capture carries a different digest. Difference, not magnitude. */
  | 'different'
  /** A digest is missing on one side, so the comparison cannot be made. */
  | 'digest-unavailable';

export interface CrossCaptureAgreement {
  state: CrossCaptureState;
  /** Captures of this URL the job knows of, the chosen one included. */
  captureCount: number;
  /** The adjacent capture compared against, when there was one. */
  comparedTimestamp: string | null;
  /** Seconds between the chosen capture and the compared one. */
  distanceSeconds: number | null;
}

export interface FidelityScore {
  originalUrl: string;
  /** The weighted mean of the measured signals below, 0 to 1. */
  score: number;
  /** The weight actually applied: the sum over signals that were measured. */
  appliedWeight: number;
  band: FidelityBand;
  /** The bands this score was cut at, so the verdict is auditable in place. */
  thresholds: FidelityThresholds;
  signals: FidelitySignal[];
  /**
   * The outcome that let this item be scored at all. Always `ok`: issue #5's
   * rule is the gate, and it is recorded here rather than restated as a rule.
   */
  gateOutcome: ItemOutcome;
  /** True when the band is `review-required` and no override is recorded. */
  promotionBlocked: boolean;
  /** The recorded operator decision that lifted a block, when there is one. */
  override: FidelityOverride | null;
}

/* -------------------------------------------------------------------------- */
/* inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** One dependency of the page being scored, as the job already records it. */
export interface AssetSummary {
  originalUrl: string;
  /** A capture of this URL was resolved. False means none is known anywhere. */
  resolved: boolean;
  /** Validated bytes for this asset are in the store. */
  acquired: boolean;
  /** The acquired capture lies outside the declared window (issue #6). */
  temporallyDistant: boolean;
}

export interface FidelityInput {
  originalUrl: string;
  /**
   * What the pipeline treats this URL as. Only a markup document is scored:
   * see `MARKUP_RELATIONS`.
   */
  relation: LinkRelation | 'page';
  /** The outcome issue #5 assigned. Anything but `ok` means no score. */
  outcome: ItemOutcome;
  /** Decoded text, or null for a binary body. A binary body is not scored. */
  text: string | null;
  /** `item.encoding.replacementRatio`, read, never recomputed (issue #4). */
  replacementRatio: number;
  /** Every capture of this URL the job knows of (issue #6's capture index). */
  captures: readonly CaptureCandidate[];
  /** The capture whose bytes were scored. */
  chosenTimestamp: string | null;
  /** The dependencies this page referenced (issue #6's resolutions). */
  assets: readonly AssetSummary[];
}

export interface FidelityContext {
  config: FidelityConfig;
  /** How many pages of the collection carry each normalized text segment. */
  segmentFrequency: ReadonlyMap<string, number>;
  /** Original URLs in this collection that hold validated bytes. */
  capturedUrls: ReadonlySet<string>;
}

/* -------------------------------------------------------------------------- */
/* scoring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Relations whose bytes are a document a reader would look at.
 *
 * The same pair `src/validate.ts` calls markup, and deliberately the pipeline's
 * own notion rather than a sniff of the body. A stylesheet decodes as text and
 * classifies as `ok`, and scoring it as a page would report it as
 * review-required for having no `<title>` and no outgoing links, which is a
 * true statement about a stylesheet and a useless one.
 */
const MARKUP_RELATIONS = new Set<LinkRelation | 'page'>(['page', 'frame']);

/**
 * One page, one score, or null when there is no page here to score.
 *
 * Null in three cases, all deliberate. An outcome other than `ok` is issue
 * #5's gate and is never overridden here. A relation that is not a markup
 * document is not a page. And a body that decoded as binary has no title, no
 * segments and no links, so every signal below would be measuring the absence
 * of markup rather than the fidelity of a page.
 */
export function scoreItem(input: FidelityInput, context: FidelityContext): FidelityScore | null {
  if (input.outcome !== 'ok') return null;
  if (!MARKUP_RELATIONS.has(input.relation)) return null;
  if (input.text === null) return null;

  const { config } = context;
  const text = input.text;
  const segments = segmentsOf(text);

  const signals: FidelitySignal[] = [
    structureSignal(input, segments, context),
    boilerplateSignal(segments, context),
    encodingSignal(input.replacementRatio, config),
    assetSignal(input.assets, config),
    crossCaptureSignal(input, config),
  ];

  const appliedWeight = signals.reduce(
    (total, signal) => (signal.value === null ? total : total + signal.weight),
    0,
  );
  const score =
    appliedWeight === 0 ? 0 : signals.reduce((total, s) => total + s.contribution, 0) / appliedWeight;
  const band = bandFor(score, config.thresholds);
  const override = config.overrides.find((entry) => entry.originalUrl === input.originalUrl) ?? null;

  return {
    originalUrl: input.originalUrl,
    score: round(score),
    appliedWeight: round(appliedWeight),
    band,
    thresholds: config.thresholds,
    signals,
    gateOutcome: input.outcome,
    promotionBlocked: band === 'review-required' && override === null,
    override: band === 'review-required' ? override : null,
  };
}

export function bandFor(score: number, thresholds: FidelityThresholds): FidelityBand {
  if (score >= thresholds.accept) return 'accept';
  if (score >= thresholds.acceptWithWarning) return 'accept-with-warning';
  return 'review-required';
}

/**
 * The measured signal that scored lowest, which is where a repair starts.
 *
 * Unmeasured signals are skipped: "the asset signal is weakest" is not a
 * useful thing to say about a page that references no assets.
 */
export function weakestSignal(score: FidelityScore): FidelitySignal | null {
  let weakest: FidelitySignal | null = null;
  for (const signal of score.signals) {
    if (signal.value === null) continue;
    if (weakest === null || signal.value < (weakest.value ?? 1)) weakest = signal;
  }
  return weakest;
}

/* -------------------------------------------------------------------------- */
/* individual signals                                                          */
/* -------------------------------------------------------------------------- */

const TITLE = /<title\b[^>]*>([\s\S]{0,400}?)<\/title\s*>/iu;

/**
 * Structural sanity, as three graded checks rather than one verdict.
 *
 * A non-empty title, visible body text above a floor, and at least one link
 * that resolves to something this collection actually holds. The third is the
 * one that separates a real page from a shell: a stub can have a title and a
 * sentence, but a page wired into its own site points somewhere real.
 *
 * `src/validate.ts` is untouched. It answers whether usable bytes arrived,
 * which is a pass/fail question on the fetch axis. This is a graded question
 * about a page that already passed it.
 */
function structureSignal(
  input: FidelityInput,
  segments: readonly string[],
  context: FidelityContext,
): FidelitySignal {
  const text = input.text ?? '';
  const title = stripTags(TITLE.exec(text)?.[1] ?? '');
  const hasTitle = title.length > 0;

  const bodyCharacters = segments.reduce((total, segment) => total + segment.length, 0);
  const lengthValue = clamp(bodyCharacters / context.config.tuning.bodyTextTarget);

  const links = discoverLinks(text, input.originalUrl).filter((link) => link.relation === 'link');
  const resolving = links.filter(
    (link) => link.resolvedUrl !== input.originalUrl && context.capturedUrls.has(link.resolvedUrl),
  );
  // A collection that holds one page has nowhere for an internal link to
  // point, so the sub-check is dropped rather than scored 0 against a page
  // that could not have passed it.
  const linkMeasurable = context.capturedUrls.size > 1;
  const linkValue = resolving.length > 0 ? 1 : 0;

  const parts = [hasTitle ? 1 : 0, lengthValue, ...(linkMeasurable ? [linkValue] : [])];
  const value = parts.reduce((total, part) => total + part, 0) / parts.length;

  return signal('structure', value, context.config.weights.structure, {
    detail:
      `title ${hasTitle ? 'present' : 'empty or absent'}; ${String(bodyCharacters)} visible characters against a ` +
      `${String(context.config.tuning.bodyTextTarget)} floor; ` +
      (linkMeasurable
        ? `${String(resolving.length)} of ${String(links.length)} declared links resolve to a body this collection holds`
        : 'this collection holds one page, so no internal link could resolve and the check is not counted'),
    measurements: {
      hasTitle,
      titleLength: title.length,
      bodyCharacters,
      bodyTextTarget: context.config.tuning.bodyTextTarget,
      lengthValue: round(lengthValue),
      declaredLinks: links.length,
      resolvingLinks: resolving.length,
      linkCheckCounted: linkMeasurable,
    },
  });
}

/**
 * Text-to-boilerplate ratio, defined by the collection rather than by taste.
 *
 * Boilerplate is what repeats: the navigation bar, the footer, the copyright
 * line. So a text segment that appears on at least `boilerplateMinDocuments`
 * pages of this collection is boilerplate, and the ratio is the share of a
 * page's visible characters that is not. A content page is mostly its own
 * words; a navigation shell is almost entirely other pages' words.
 *
 * This reads no prose for meaning, which is the property that keeps a hostile
 * capture from being able to talk its way into a high score.
 */
function boilerplateSignal(segments: readonly string[], context: FidelityContext): FidelitySignal {
  const { tuning, weights } = context.config;
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const shared = segments
    .filter((segment) => (context.segmentFrequency.get(segment) ?? 0) >= tuning.boilerplateMinDocuments)
    .reduce((sum, segment) => sum + segment.length, 0);

  const uniqueRatio = total === 0 ? 0 : (total - shared) / total;
  const value = scale(uniqueRatio, tuning.boilerplateZeroRatio, tuning.boilerplateFullRatio);

  return signal('boilerplate', value, weights.boilerplate, {
    detail:
      `${String(total - shared)} of ${String(total)} visible characters are unique to this page ` +
      `(${(uniqueRatio * 100).toFixed(1)}%); segments on ${String(tuning.boilerplateMinDocuments)}+ pages count as boilerplate`,
    measurements: {
      segments: segments.length,
      totalCharacters: total,
      boilerplateCharacters: shared,
      uniqueRatio: round(uniqueRatio),
      zeroRatio: tuning.boilerplateZeroRatio,
      fullRatio: tuning.boilerplateFullRatio,
    },
  });
}

/**
 * The replacement-character ratio issue #4 already measured, graded.
 *
 * Read from `item.encoding.replacementRatio`; nothing is re-decoded here. The
 * decoder's own `degraded` flag stays the binary fact it is, and this turns
 * the same number into a slope, because a page at 0.002 and a page at 0.04 are
 * not equally readable even though neither is simply broken.
 */
function encodingSignal(replacementRatio: number, config: FidelityConfig): FidelitySignal {
  const zero = config.tuning.encodingZeroRatio;
  const value = zero <= 0 ? (replacementRatio > 0 ? 0 : 1) : clamp(1 - replacementRatio / zero);

  return signal('encoding', value, config.weights.encoding, {
    detail:
      `replacement-character ratio ${replacementRatio.toFixed(4)} against a zero point of ${String(zero)}`,
    measurements: { replacementRatio: round(replacementRatio), zeroRatio: zero },
  });
}

/**
 * Asset completeness, read off issue #6's resolutions.
 *
 * A page that references nothing is not complete, it is unmeasurable, so the
 * signal is dropped rather than awarded a free 1. Nothing is re-resolved here,
 * and no request can be made from this module.
 */
function assetSignal(assets: readonly AssetSummary[], config: FidelityConfig): FidelitySignal {
  if (assets.length === 0) {
    return signal('assets', null, config.weights.assets, {
      detail: 'this page references no dependency, so there is no completeness to measure',
      measurements: { assets: 0, acquired: 0, unresolved: 0, temporallyDistant: 0 },
    });
  }

  let credit = 0;
  let acquired = 0;
  let unresolved = 0;
  let distant = 0;
  for (const asset of assets) {
    if (!asset.resolved) {
      credit += ASSET_CREDIT.unresolved;
      unresolved += 1;
    } else if (!asset.acquired) {
      credit += ASSET_CREDIT.resolvedNotAcquired;
    } else if (asset.temporallyDistant) {
      credit += ASSET_CREDIT.temporallyDistant;
      acquired += 1;
      distant += 1;
    } else {
      credit += ASSET_CREDIT.acquired;
      acquired += 1;
    }
  }

  const value = clamp(credit / assets.length);
  return signal('assets', value, config.weights.assets, {
    detail:
      `${String(acquired)} of ${String(assets.length)} dependencies acquired; ${String(unresolved)} have no known ` +
      `capture and ${String(distant)} came from outside the declared window`,
    measurements: { assets: assets.length, acquired, unresolved, temporallyDistant: distant },
  });
}

/**
 * Cross-capture agreement, by provider digest, at zero request cost.
 *
 * The honest version of this signal, and the limitation is the point. Comparing
 * the *text* of adjacent captures would mean acquiring bodies this job never
 * asked for: one extra replay request per adjacent capture per page. That
 * breaks issue #8's own zero-network criterion and the acquisition budget with
 * it, and skipping the pages it cannot afford would make the signal quietly
 * absent on most of a collection.
 *
 * CDX rows already carry the provider's digest, and issue #6 retained every
 * row on the job. Identical digests prove identical bytes for free. Differing
 * digests prove only that something changed, never how much: a corrected typo
 * and a replacement by a parking page are the same observation here.
 *
 * So the signal is binary in what it can establish, and it is scored that way:
 * agreement is a measurement worth 1, and every other state is *unmeasured*
 * rather than penalised. `different` in particular contributes nothing: a
 * changed digest is not evidence that this capture is worse, and scoring it as
 * though it were would invent a number the digest cannot support. The signal
 * can corroborate; it can never refute. The state is written to the report so
 * `different` is never read as a measured disagreement.
 */
export function crossCaptureAgreement(
  captures: readonly CaptureCandidate[],
  chosenTimestamp: string | null,
): CrossCaptureAgreement {
  const known = captures.filter((candidate) => /^\d{4,14}$/.test(candidate.timestamp));
  if (known.length <= 1) {
    return { state: 'single-capture', captureCount: known.length, comparedTimestamp: null, distanceSeconds: null };
  }

  const chosen =
    known.find((candidate) => candidate.timestamp === chosenTimestamp) ?? (known[0] as CaptureCandidate);
  const chosenEpoch = timestampToEpochMs(expandTimestamp(chosen.timestamp, 'start'));

  let adjacent: CaptureCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    if (candidate === chosen) continue;
    const epoch = timestampToEpochMs(expandTimestamp(candidate.timestamp, 'start'));
    const distance =
      chosenEpoch === null || epoch === null ? Number.POSITIVE_INFINITY : Math.abs(epoch - chosenEpoch);
    if (distance < bestDistance || (adjacent === null && !Number.isFinite(distance))) {
      adjacent = candidate;
      bestDistance = distance;
    }
  }

  if (adjacent === null) {
    return { state: 'single-capture', captureCount: known.length, comparedTimestamp: null, distanceSeconds: null };
  }

  const distanceSeconds = Number.isFinite(bestDistance) ? Math.round(bestDistance / 1000) : null;
  const chosenDigest = emptyToNull(chosen.digest);
  const adjacentDigest = emptyToNull(adjacent.digest);
  const state: CrossCaptureState =
    chosenDigest === null || adjacentDigest === null
      ? 'digest-unavailable'
      : chosenDigest === adjacentDigest
        ? 'identical'
        : 'different';

  return {
    state,
    captureCount: known.length,
    comparedTimestamp: adjacent.timestamp,
    distanceSeconds,
  };
}

const CROSS_CAPTURE_DETAIL: Readonly<Record<CrossCaptureState, string>> = {
  'single-capture': 'one capture is known, so there is nothing to compare against',
  identical: 'an adjacent capture carries the same provider digest, so the bytes are identical',
  different:
    'an adjacent capture carries a different provider digest: the bytes changed, by an amount a digest cannot measure',
  'digest-unavailable': 'a provider digest is missing on one side, so no comparison could be made',
};

function crossCaptureSignal(input: FidelityInput, config: FidelityConfig): FidelitySignal {
  const agreement = crossCaptureAgreement(input.captures, input.chosenTimestamp);
  const value = agreement.state === 'identical' ? 1 : null;

  return signal('cross-capture', value, config.weights['cross-capture'], {
    detail: `${CROSS_CAPTURE_DETAIL[agreement.state]} (${String(agreement.captureCount)} capture(s) known)`,
    measurements: {
      state: agreement.state,
      captureCount: agreement.captureCount,
      comparedTimestamp: agreement.comparedTimestamp,
      distanceSeconds: agreement.distanceSeconds,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* collection context                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How many pages of this collection carry each normalized text segment.
 *
 * Built once per pass over the same decoded texts the classification pass
 * already holds, so scoring a whole collection costs one extra walk over
 * strings and no extra read.
 */
export function buildSegmentFrequency(texts: Iterable<string>): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const text of texts) {
    for (const segment of new Set(segmentsOf(text))) {
      frequency.set(segment, (frequency.get(segment) ?? 0) + 1);
    }
  }
  return frequency;
}

/**
 * Visible text, split at block boundaries and normalized.
 *
 * Normalization drops case and collapses whitespace so that the same
 * navigation bar matches across pages whose markup was hand-edited. Scripts,
 * styles and comments are removed before anything is measured: a page is not
 * more substantial for carrying a large script.
 */
export function segmentsOf(text: string): string[] {
  const withoutNoise = text
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/giu, ' ');

  return withoutNoise
    .split(BLOCK_BOUNDARY)
    .map((chunk) => stripTags(chunk))
    .filter((chunk) => chunk.length > 0);
}

const BLOCK_BOUNDARY =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|h[1-6]|blockquote|pre|section|article|header|footer|nav|aside|form|center|address)\b[^>]*>/giu;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function signal(
  name: FidelitySignalName,
  value: number | null,
  weight: number,
  parts: { detail: string; measurements: FidelitySignal['measurements'] },
): FidelitySignal {
  const bounded = value === null ? null : round(clamp(value));
  return {
    name,
    value: bounded,
    weight,
    contribution: bounded === null ? 0 : round(bounded * weight),
    detail: parts.detail,
    measurements: parts.measurements,
  };
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A value's position between two bounds, clamped to 0 and 1 outside them. */
function scale(value: number, zeroAt: number, oneAt: number): number {
  if (oneAt <= zeroAt) return value > zeroAt ? 1 : 0;
  return clamp((value - zeroAt) / (oneAt - zeroAt));
}

/** Four decimals, so a report diff is stable across platforms. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function emptyToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}
