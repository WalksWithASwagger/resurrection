/**
 * Persistent work items.
 *
 * The job file is the durable record of an acquisition: what the inventory
 * returned, which items exist, what happened to each one and how much budget
 * has been spent. It is written through after every item, so an interrupted
 * process leaves a resumable job rather than a lost one, and a resume never
 * re-fetches work that already has validated bytes.
 *
 * One item per original URL. A URL's identity and its content's identity are
 * separate: two items that receive identical bytes share one stored object and
 * keep their own records (docs/SPEC.md section 9).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BudgetSpend, Budgets } from './budget.ts';
import type { CdxQuery } from './cdx.ts';
import type { ScopeConfig } from './config.ts';
import type { LinkRelation } from './discover.ts';
import type { Failure, OutcomeRecord, UnattemptedReason } from './outcomes.ts';
import type { CaptureCandidate, CaptureSelection } from './select.ts';

export const JOB_FILE = 'job.json';
/** 2 added the capture candidate set, the selection record and the timeline. */
export const JOB_STATE_VERSION = 2;

export type ItemKind = 'page' | 'dependency';
export type ItemStatus = 'unattempted' | 'fetched' | 'failed' | 'skipped';
export type RunState = 'running' | 'paused' | 'cancelled' | 'complete' | 'interrupted';

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface CaptureRecord {
  /** The capture time the fetch asked for. */
  requestedTimestamp: string | null;
  /** The capture time the provider actually served. */
  servedTimestamp: string | null;
  distanceSeconds: number | null;
  /** `id_` for pages, assets and documents; `if_` for frames. */
  replayModifier: string;
  /** Other captures the inventory offered, kept for reselection in M2. */
  alternatives: string[];
  /**
   * Every capture the inventory offered, with the row metadata a selection
   * policy needs. Retaining it is what makes reselecting a different capture
   * cost zero index requests.
   */
  candidates: CaptureCandidate[];
  /** Which policy chose `requestedTimestamp`, and why. */
  selection: CaptureSelection | null;
  /** The provider's own digest, never mixed with the local body hash. */
  archiveDigest: string | null;
  /**
   * The origin's status at crawl time, verbatim from the CDX row. It is the
   * provider's metadata about the capture, not the status of the replay, and
   * it is what establishes a site's own error template (src/classify.ts).
   */
  archiveStatus: string | null;
}

export interface FetchRecord {
  requestUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  redirectChain: RedirectHop[];
  /** Attempts charged to the budget for this item, retries included. */
  attempts: number;
  /** Bytes charged to the budget across every attempt for this item. */
  bytesRead: number;
  /** Length of the body that was stored. Zero when nothing was stored. */
  bodyLength: number;
  bodyHash: string | null;
  storePath: string | null;
  contentType: string | null;
  truncated: boolean;
  retrievedAt: string;
  /** Bytes arrived and passed response and content validation. */
  validated: boolean;
  /**
   * What the defensive archive-injection strip found. On a correct identity
   * fetch this records a clean scan, which is the evidence that the stripper
   * is insurance rather than load-bearing work.
   */
  archiveInjection: ArchiveInjectionRecord | null;
}

export interface ArchiveInjectionRecord {
  /** False for a binary body, where there is no markup to scan. */
  scanned: boolean;
  removedNodes: number;
  /** Which rules fired. Body text never reaches the record. */
  rules: string[];
  removedCharacters: number;
  /** Injection markers still present after stripping. */
  residualMarkers: string[];
}

/** The decode decision, flattened from DecodeResult for the evidence report. */
export interface EncodingRecord {
  kind: 'text' | 'binary';
  declaredEncoding: string | null;
  declaredSource: string | null;
  chosenEncoding: string | null;
  chosenSource: string;
  detectionConfidence: number;
  cp1252UpgradeApplied: boolean;
  declarationOverridden: boolean;
  declarationConflict: boolean;
  replacementCount: number;
  replacementRatio: number;
  replacementThreshold: number;
  degraded: boolean;
  binaryReason: string | null;
}

export interface WorkItem {
  id: string;
  originalUrl: string;
  kind: ItemKind;
  relation: LinkRelation | 'page';
  discoveredFrom: string | null;
  discoveredAt: string;
  /** Where this URL maps inside an export. A mapping is not a recovered file. */
  localPath: string;
  status: ItemStatus;
  unattemptedReason: UnattemptedReason | null;
  failure: Failure | null;
  capture: CaptureRecord;
  fetch: FetchRecord | null;
  encoding: EncodingRecord | null;
  /**
   * What this item actually holds, on the content axis. Derived from the
   * records above by src/classify.ts, never a second status the fetch loop
   * writes by hand. Null until a classification pass has run.
   */
  outcome: OutcomeRecord | null;
  notes: string[];
}

export interface InventoryRun {
  id: string;
  query: CdxQuery;
  requestUrl: string;
  issuedAt: string;
  /** Local hash of the raw index response, which is retained in the store. */
  rawResponseHash: string | null;
  rawResponsePath: string | null;
  rowCount: number;
  /**
   * The acquisition-candidate rule applied to this run's rows. It is applied
   * here rather than sent upstream, so excluded rows survive as evidence.
   */
  candidateFilters: string[];
  candidateRowCount: number;
  /** Rows excluded from acquisition and kept in `JobState.timeline`. */
  timelineRowCount: number;
  resumeKey: string | null;
  limitReached: boolean;
  outcome: 'complete' | 'continued' | 'failed';
  failure: Failure | null;
}

/**
 * A capture that is evidence of the origin's history rather than a page to
 * rebuild: a redirect, a gone URL, a server error. Retained, never fetched.
 */
export interface TimelineEntry {
  originalUrl: string;
  timestamp: string;
  statusCode: string;
  mimetype: string;
  digest: string;
  length: string;
  /** The candidate filter expression this row failed, verbatim. */
  excludedBy: string;
}

export interface JobEvent {
  at: string;
  kind: 'started' | 'resumed' | 'paused' | 'cancelled' | 'completed' | 'interrupted';
  detail: string;
}

export interface JobState {
  version: number;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  runState: RunState;
  scope: ScopeConfig;
  budgets: Budgets;
  spend: BudgetSpend;
  inventoryRuns: InventoryRun[];
  /** Non-candidate captures, retained as evidence of when a URL changed. */
  timeline: TimelineEntry[];
  items: WorkItem[];
  events: JobEvent[];
}

export function itemId(originalUrl: string): string {
  return createHash('sha256').update(originalUrl).digest('hex').slice(0, 16);
}

export function findItem(state: JobState, originalUrl: string): WorkItem | undefined {
  const id = itemId(originalUrl);
  return state.items.find((item) => item.id === id);
}

/** An item that already holds validated bytes is never attempted again. */
export function isComplete(item: WorkItem): boolean {
  return item.status === 'fetched' && item.fetch?.bodyHash != null && item.fetch.validated;
}

/**
 * Validated bytes and recovered content are different claims, and an M2
 * reference needs both. An unclassified item is never eligible.
 */
export function referenceEligible(item: WorkItem): boolean {
  return isComplete(item) && item.outcome?.referenceEligible === true;
}

export async function saveJob(directory: string, state: JobState): Promise<void> {
  const path = join(directory, JOB_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/**
 * The project a job on disk belongs to, read without validating its version.
 *
 * The demo entry point clears only its own output directory, and it has to be
 * able to make that check against a job written by an older build of this
 * package. Refusing to read the name would turn a stale directory into a
 * verification command that fails on prior working-tree state.
 */
export async function readJobProjectId(directory: string): Promise<string | null> {
  const text = await readFile(join(directory, JOB_FILE), 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const projectId = (parsed as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' ? projectId : null;
}

export async function loadJob(directory: string): Promise<JobState | null> {
  const path = join(directory, JOB_FILE);
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`job file ${path} is not an object`);
  }
  const state = parsed as JobState;
  if (state.version !== JOB_STATE_VERSION) {
    throw new Error(`job file ${path} has version ${String(state.version)}, expected ${JOB_STATE_VERSION}`);
  }
  return state;
}
