/**
 * The independent evaluator (docs/SPEC.md sections 6 and 8, docs/EVALUATION.md).
 *
 * It renders a candidate under the reference bundle's own conditions and
 * compares the two. It owns the thresholds and reads the golden images from a
 * bundle it has first verified, so whatever produced the candidate cannot
 * adjust what it is judged against.
 *
 * A pass says exactly this: for the states in the bundle, under its recorded
 * conditions, every check below held. It says nothing about pages or states
 * the bundle does not contain.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { candidatePathOf, candidateResponder, candidateUrlFor, loadCandidate, type Candidate } from './candidate.ts';
import { siteKey } from './collection.ts';
import { compareImages, decodePng, encodePng } from './png.ts';
import {
  loadReferenceBundle,
  verifyReferenceBundle,
  type Anchor,
  type ReferenceRenderer,
  type ReferenceState,
  type RenderConditions,
  type RenderResult,
} from './reference.ts';
import { CODE_REVISION } from './revision.ts';

export const EVALUATION_FILE = 'evaluation.json';
export const EVALUATION_SCHEMA_VERSION = 1;

export interface AcceptanceThresholds {
  /** Largest share of differing pixels a state may have. */
  maxDifferingPixelRatio: number;
  /** Per-pixel colour threshold, 0 to 1. */
  pixelThreshold: number;
  /** How far an anchor's position or size may move, in CSS pixels. */
  anchorTolerancePx: number;
}

/** SPEC section 8's initial criteria. Calibrate on a pilot before calling a result verified. */
export const DEFAULT_ACCEPTANCE: AcceptanceThresholds = {
  maxDifferingPixelRatio: 0.01,
  pixelThreshold: 0.1,
  anchorTolerancePx: 2,
};

export type CheckName = 'route' | 'title' | 'text' | 'visual' | 'geometry' | 'links' | 'runtime';

export interface CheckResult {
  name: CheckName;
  pass: boolean;
  detail: string;
  metrics: Record<string, number>;
}

export interface StateEvaluation {
  pageId: string;
  originalUrl: string;
  familyId: string;
  candidatePath: string | null;
  pass: boolean;
  checks: CheckResult[];
  /** Relative path of the difference image, when any pixel differed. */
  diffImage: string | null;
}

export type Verdict =
  | 'pass'
  /** Every check held, but the reference has no sign-off, so nothing is verified. */
  | 'pass-against-unfrozen-reference'
  | 'fail';

export interface EvaluationReport {
  schemaVersion: number;
  codeRevision: string;
  bundleDigest: string;
  referenceFrozen: boolean;
  candidateDigest: string;
  acceptance: AcceptanceThresholds;
  conditions: RenderConditions;
  states: StateEvaluation[];
  summary: { states: number; passed: number; failed: number };
  verdict: Verdict;
}

export interface EvaluateOptions {
  bundleDirectory: string;
  candidateDirectory: string;
  outputDirectory: string;
  renderer: ReferenceRenderer;
  /** Refuse to evaluate against a bundle with no sign-off. Default true. */
  requireFrozenReference?: boolean;
  acceptance?: AcceptanceThresholds;
  /** Evaluate only these states. The report then covers only them. */
  onlyPageIds?: readonly string[];
}

const check = (name: CheckName, pass: boolean, detail: string, metrics: Record<string, number> = {}): CheckResult => ({
  name,
  pass,
  detail,
  metrics,
});

function geometryCheck(reference: readonly Anchor[], candidate: readonly Anchor[], tolerance: number): CheckResult {
  const key = (anchor: Anchor): string => `${anchor.tag}#${anchor.ordinal}`;
  const candidateByKey = new Map(candidate.map((anchor) => [key(anchor), anchor]));
  const referenceKeys = new Set(reference.map(key));
  const moved: { key: string; offset: number }[] = [];
  let missing = 0;
  for (const anchor of reference) {
    const other = candidateByKey.get(key(anchor));
    if (other === undefined) {
      missing += 1;
      continue;
    }
    const offset = Math.max(
      Math.abs(anchor.rect.x - other.rect.x),
      Math.abs(anchor.rect.y - other.rect.y),
      Math.abs(anchor.rect.width - other.rect.width),
      Math.abs(anchor.rect.height - other.rect.height),
    );
    if (offset > tolerance) moved.push({ key: key(anchor), offset });
  }
  const extra = candidate.filter((anchor) => !referenceKeys.has(key(anchor))).length;
  moved.sort((a, b) => b.offset - a.offset || a.key.localeCompare(b.key));
  const worst = moved.slice(0, 8).map((entry) => `${entry.key} by ${entry.offset}px`).join(', ');
  const pass = missing === 0 && extra === 0 && moved.length === 0;
  return check(
    'geometry',
    pass,
    pass
      ? `${reference.length} anchors within ${tolerance}px`
      : `${moved.length} moved${worst === '' ? '' : ` (${worst})`}, ${missing} missing, ${extra} unexpected`,
    { anchors: reference.length, moved: moved.length, missing, extra, worstOffsetPx: moved[0]?.offset ?? 0 },
  );
}

function fragmentOf(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return '';
  }
}

/**
 * Every reference link must lead to the same place in the candidate. A link
 * whose original target was never recovered is a gap: the candidate may send
 * it nowhere, but may not send it to a different recovered page.
 */
function linksCheck(reference: readonly Anchor[], rendered: readonly Anchor[], candidate: Candidate): CheckResult {
  const candidateLinks = new Map(rendered.filter((anchor) => anchor.tag === 'a').map((anchor) => [anchor.ordinal, anchor]));
  const wrong: string[] = [];
  let compared = 0;
  let gaps = 0;
  let scriptLinks = 0;
  for (const anchor of reference) {
    if (anchor.tag !== 'a' || anchor.target === null) continue;
    // A javascript: link is script behavior, which no reference state covers.
    if (/^javascript:/i.test(anchor.target)) {
      scriptLinks += 1;
      continue;
    }
    compared += 1;
    const expectedKey = siteKey(anchor.target);
    const actual = candidateLinks.get(anchor.ordinal)?.target ?? null;
    const localPath = actual === null ? null : candidatePathOf(actual);
    const actualKey = actual === null ? null : localPath === null ? siteKey(actual) : (candidate.keyByPath.get(localPath) ?? null);
    const recovered = candidate.pathByKey.has(expectedKey);

    const sameFragment = actual === null || fragmentOf(actual) === fragmentOf(anchor.target);
    if (actualKey === expectedKey && sameFragment) continue;
    // Two original URLs can name one file, such as a folder and its index page.
    if (localPath !== null && candidate.pathByKey.get(expectedKey) === localPath && sameFragment) continue;
    if (!recovered && localPath !== null && actualKey === null) {
      gaps += 1;
      continue;
    }
    wrong.push(`a#${anchor.ordinal} "${anchor.label.slice(0, 40)}" expected ${anchor.target}, got ${actual ?? 'no link'}`);
  }
  return check(
    'links',
    wrong.length === 0,
    wrong.length === 0 ? `${compared} links lead to the same place (${gaps} to unrecovered targets)` : wrong.slice(0, 8).join('; '),
    { links: compared, wrong: wrong.length, unrecoveredTargets: gaps, scriptLinksNotCompared: scriptLinks },
  );
}

function runtimeCheck(result: RenderResult): CheckResult {
  const missing = result.requests.filter((record) => record.disposition === 'missing');
  const external = result.requests.filter((record) => record.disposition === 'blocked-external');
  const problems = [
    ...missing.map((record) => `missing local resource ${record.url}`),
    ...external.map((record) => `external request ${record.url}`),
    ...result.pageErrors.map((message) => `script error: ${message}`),
  ];
  return check(
    'runtime',
    problems.length === 0,
    problems.length === 0 ? 'every request was served locally and no script error was raised' : problems.slice(0, 8).join('; '),
    { missingResources: missing.length, externalRequests: external.length, scriptErrors: result.pageErrors.length },
  );
}

async function evaluateState(
  state: ReferenceState,
  options: EvaluateOptions,
  candidate: Candidate,
  acceptance: AcceptanceThresholds,
  conditions: RenderConditions,
): Promise<StateEvaluation> {
  const base = { pageId: state.pageId, originalUrl: state.originalUrl, familyId: state.familyId };
  const url = candidateUrlFor(candidate, state.originalUrl);
  if (url === null) {
    return {
      ...base,
      candidatePath: null,
      pass: false,
      checks: [check('route', false, 'the candidate URL map has no entry for this page')],
      diffImage: null,
    };
  }

  const result = await options.renderer.render({
    url,
    viewport: conditions.viewport,
    javaScriptEnabled: true,
    respond: candidateResponder(candidate),
  });
  const checks: CheckResult[] = [check('route', true, `served from ${candidatePathOf(url) ?? url}`)];

  checks.push(check('title', result.title === state.title, result.title === state.title ? 'title matches' : `expected "${state.title}", got "${result.title}"`));

  const textHash = createHash('sha256').update(result.text).digest('hex');
  checks.push(
    check(
      'text',
      textHash === state.textSha256,
      textHash === state.textSha256 ? 'rendered text matches' : `rendered text differs (${state.textLength} characters expected, ${result.text.length} rendered)`,
      { expectedLength: state.textLength, renderedLength: result.text.length },
    ),
  );

  const referenceImage = decodePng(new Uint8Array(await readFile(join(options.bundleDirectory, state.screenshot.path))));
  const comparison = compareImages(referenceImage, decodePng(result.screenshot), acceptance.pixelThreshold);
  const visualPass = comparison.sameSize && comparison.ratio <= acceptance.maxDifferingPixelRatio;
  let diffImage: string | null = null;
  if (comparison.differingPixels > 0) {
    diffImage = `diffs/${state.pageId}.png`;
    const absolute = join(options.outputDirectory, diffImage);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, encodePng(comparison.diff));
  }
  const bounds = comparison.bounds;
  checks.push(
    check(
      'visual',
      visualPass,
      `${comparison.differingPixels} of ${comparison.comparedPixels} pixels differ (${(comparison.ratio * 100).toFixed(3)}%)` +
        (comparison.sameSize ? '' : `; size ${comparison.width}x${comparison.height} differs from reference ${referenceImage.width}x${referenceImage.height}`) +
        (bounds === null ? '' : `; within ${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y}`) +
        (state.screenshot.stable && result.screenshotStable ? '' : '; a capture was not stable, so some difference may be animation'),
      { differingPixels: comparison.differingPixels, comparedPixels: comparison.comparedPixels, ratio: comparison.ratio },
    ),
  );

  checks.push(geometryCheck(state.anchors, result.anchors.map((anchor) => ({ ...anchor, rect: roundRect(anchor.rect) })), acceptance.anchorTolerancePx));
  checks.push(linksCheck(state.anchors, result.anchors, candidate));
  checks.push(runtimeCheck(result));

  return { ...base, candidatePath: candidatePathOf(url), pass: checks.every((entry) => entry.pass), checks, diffImage };
}

function roundRect(rect: Anchor['rect']): Anchor['rect'] {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

export async function evaluateCandidate(options: EvaluateOptions): Promise<EvaluationReport> {
  const verification = await verifyReferenceBundle(options.bundleDirectory);
  if (!verification.ok) throw new Error(`reference bundle does not verify: ${verification.problems.join('; ')}`);
  if (!verification.frozen && (options.requireFrozenReference ?? true)) {
    throw new Error('reference bundle has no sign-off; sign it off or evaluate with the unfrozen option');
  }
  const bundle = await loadReferenceBundle(options.bundleDirectory);
  const conditions = await options.renderer.conditions(bundle.conditions.viewport);
  if (JSON.stringify(conditions) !== JSON.stringify(bundle.conditions)) {
    throw new Error(
      `render conditions differ from the bundle's (${conditions.browser} ${conditions.browserVersion} on ${conditions.platform} ` +
        `against ${bundle.conditions.browser} ${bundle.conditions.browserVersion} on ${bundle.conditions.platform})`,
    );
  }

  const candidate = await loadCandidate(options.candidateDirectory);
  const acceptance = options.acceptance ?? DEFAULT_ACCEPTANCE;
  const states: StateEvaluation[] = [];
  const only = options.onlyPageIds === undefined ? null : new Set(options.onlyPageIds);
  for (const state of bundle.states.filter((entry) => only === null || only.has(entry.pageId))) states.push(await evaluateState(state, options, candidate, acceptance, bundle.conditions));

  const passed = states.filter((state) => state.pass).length;
  const allPassed = states.length > 0 && passed === states.length;
  const report: EvaluationReport = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    codeRevision: CODE_REVISION,
    bundleDigest: bundle.digest,
    referenceFrozen: verification.frozen,
    candidateDigest: candidate.digest,
    acceptance,
    conditions: bundle.conditions,
    states,
    summary: { states: states.length, passed, failed: states.length - passed },
    verdict: !allPassed ? 'fail' : verification.frozen ? 'pass' : 'pass-against-unfrozen-reference',
  };

  await mkdir(options.outputDirectory, { recursive: true });
  const path = join(options.outputDirectory, EVALUATION_FILE);
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
  return report;
}

export function summarizeEvaluation(report: EvaluationReport): string {
  const lines = [
    `evaluation of candidate ${report.candidateDigest.slice(0, 12)} against bundle ${report.bundleDigest.slice(0, 12)}: ${report.verdict}`,
    `  ${report.summary.passed} of ${report.summary.states} states passed` +
      (report.referenceFrozen ? '' : ' (the reference has no sign-off, so this verifies nothing)'),
  ];
  for (const state of report.states) {
    lines.push(`  ${state.pass ? 'pass' : 'FAIL'} ${state.familyId} ${state.originalUrl}`);
    for (const entry of state.checks) {
      if (!entry.pass) lines.push(`      ${entry.name}: ${entry.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
