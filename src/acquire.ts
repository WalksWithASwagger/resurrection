/**
 * The acquisition orchestrator.
 *
 * Inventory and acquisition are separate states (docs/SPEC.md section 3): the
 * index run records what the provider said exists, the fetch loop records what
 * actually arrived. An item that was only indexed is never reported as
 * recovered.
 *
 * The loop is interruptible by design. Job state is written through after
 * every item, so a pause, a cancel or a process that simply dies all leave the
 * same durable record, and a resume continues from it without re-fetching
 * anything that already holds validated bytes.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { BudgetLedger, EMPTY_SPEND } from './budget.ts';
import { systemClock, type Clock } from './clock.ts';
import {
  buildCdxUrl,
  parseCdxFilter,
  parseCdxJson,
  rowExclusion,
  type CdxFilter,
  type CdxQuery,
  type CdxRow,
} from './cdx.ts';
import type { ProjectConfig } from './config.ts';
import { decodeBody, type DecodeResult } from './decode.ts';
import { DEFAULT_ALLOWED_PORTS, type DnsResolver } from './destination.ts';
import { discoverLinks, localPathFor, type LinkRelation } from './discover.ts';
import {
  buildEvidenceReport,
  inventoryPartialReasons,
  loadEvidenceRevisions,
  writeEvidenceReport,
  type EvidenceReport,
} from './evidence.ts';
import { CODE_REVISION, type EvidenceRevisions } from './revision.ts';
import { fetchResource, type FetchContext } from './fetch-resource.ts';
import {
  JOB_STATE_VERSION,
  isComplete,
  itemId,
  loadJob,
  saveJob,
  type ArchiveInjectionRecord,
  type AssetLookup,
  type CaptureReselection,
  type EncodingRecord,
  type IndexedCaptureSet,
  type InventoryRun,
  type JobState,
  type ReselectionAttempt,
  type WorkItem,
} from './job.ts';
import { RateLimiter } from './ratelimit.ts';
import { outcomeForFailure, RESELECTABLE_OUTCOMES } from './outcomes.ts';
import { classifyCollection } from './reclassify.ts';
import { captureKey, resolveAssetCapture } from './resolve-asset.ts';
import { selectCapture, selectUnusedCapture, selectionTarget, type CaptureCandidate, type CaptureSelection } from './select.ts';
import { BodyStore } from './store.ts';
import { stripArchiveInjection } from './toolbar.ts';
import type { HttpTransport } from './transport.ts';
import { validateBody } from './validate.ts';
import {
  buildReplayUrl,
  captureDistanceSeconds,
  replayModifierFor,
  servedTimestamp,
} from './wayback.ts';

export type ControlSignal = 'continue' | 'pause' | 'cancel';

export interface AcquisitionOptions {
  config: ProjectConfig;
  transport: HttpTransport;
  resolver: DnsResolver;
  clock?: Clock;
  /** Checked before each item, so an operator can pause or cancel mid-run. */
  signal?: () => ControlSignal;
  /** Continue an existing job instead of refusing to overwrite it. */
  resume?: boolean;
  /** Retry items that failed in an earlier run, when the failure was retryable. */
  retryFailed?: boolean;
  /**
   * Identity of the acquiring code. Defaults to the embedded `CODE_REVISION`.
   * Never read from `.git`; pass a commit SHA here when a run should name one.
   */
  codeRevision?: string;
  /**
   * SHA-256 of the fixture manifest that produced this run, or null for a
   * live-transport run. Omitted is treated as null, never as a fabricated hash.
   */
  fixtureRevision?: string | null;
}

export interface AcquisitionResult {
  state: JobState;
  report: EvidenceReport;
  reportPath: string;
}

export async function runAcquisition(options: AcquisitionOptions): Promise<AcquisitionResult> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const directory = config.outputDirectory;
  await mkdir(directory, { recursive: true });

  const existing = await loadJob(directory);
  if (existing !== null && options.resume !== true) {
    throw new Error(
      `a job already exists in ${directory}; pass resume to continue it rather than overwriting acquired evidence`,
    );
  }
  const state = existing ?? newJobState(config, clock);
  state.runState = 'running';
  state.events.push({
    at: iso(clock),
    kind: existing === null ? 'started' : 'resumed',
    detail: `${state.items.length} items on record`,
  });

  const store = new BodyStore(join(directory, 'store'));
  const ledger = new BudgetLedger(config.budgets, clock, state.spend);
  const context: FetchContext = {
    transport: options.transport,
    resolver: options.resolver,
    policy: { allowedHosts: config.provider.allowedHosts, allowedPorts: DEFAULT_ALLOWED_PORTS },
    limiter: new RateLimiter(config.provider.minRequestIntervalMs, clock),
    ledger,
    clock,
    timeoutMs: config.provider.requestTimeoutMs,
    defaultBackoffMs: Math.max(config.provider.minRequestIntervalMs, 1000),
  };

  if (options.retryFailed === true) {
    for (const item of state.items) {
      if (item.status === 'failed' && item.failure?.retryable === true) {
        item.status = 'unattempted';
        item.unattemptedReason = 'queued';
        item.failure = null;
      }
    }
  }
  // A previous run's budget or pause left items parked. They are queued again;
  // the ledger, which carries the earlier spend, decides whether they run.
  for (const item of state.items) {
    if (item.status === 'unattempted' && item.unattemptedReason !== 'out-of-scope') {
      item.unattemptedReason = 'queued';
    }
  }

  // The declared budget in force is the configured one. Recording it on the
  // job keeps the report honest about what bounded this run, not the previous.
  state.budgets = config.budgets;

  let halted: 'paused' | 'cancelled' | null = null;
  try {
    halted = await runInventory(state, config, context, store, clock);
    // Pure, and over candidates the inventory already returned, so it costs no
    // index request. Running it on every pass is what lets an operator change
    // the policy and resume to reselect for free.
    applyCaptureSelection(state, config);
    if (halted === null) {
      seedPageItems(state, config, clock);
      halted = await runFetchLoop(state, config, context, store, clock, options.signal);
    }
    if (halted === null) {
      halted = await runOutcomeReselection(state, config, context, store, clock, options.signal);
    }
  } catch (error) {
    // The process may simply die here. The finally block below still persists
    // everything acquired so far, which is what makes a resume possible.
    state.runState = 'interrupted';
    state.events.push({
      at: iso(clock),
      kind: 'interrupted',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    state.spend = ledger.snapshot();
    state.updatedAt = iso(clock);
    if (halted === null && state.runState === 'running') {
      state.runState = allSettled(state) ? 'complete' : 'paused';
    }
    await saveJob(directory, state);
  }

  // Classification and fidelity scoring are one collection-wide pass over
  // bytes already stored, so they run once the fetch loop is over and cost no
  // requests. The same pass is what `reclassify` re-runs later.
  await classifyCollection(state, store, config.fidelity);
  await saveJob(directory, state);

  const report = buildEvidenceReport(state, config, await revisionsFor(directory, options));
  const reportPath = await writeEvidenceReport(directory, report);
  return { state, report, reportPath };
}

/**
 * Prefer revisions already on the evidence file. A resume or a later
 * re-render of the same collection must keep naming the code that acquired
 * it, even if the caller now holds a different `--code-revision`.
 */
async function revisionsFor(
  directory: string,
  options: Pick<AcquisitionOptions, 'codeRevision' | 'fixtureRevision'>,
): Promise<EvidenceRevisions> {
  const recorded = await loadEvidenceRevisions(directory);
  if (recorded !== null) return recorded;
  return {
    code: options.codeRevision ?? CODE_REVISION,
    fixture: options.fixtureRevision ?? null,
  };
}

function newJobState(config: ProjectConfig, clock: Clock): JobState {
  const now = iso(clock);
  return {
    version: JOB_STATE_VERSION,
    projectId: config.projectId,
    createdAt: now,
    updatedAt: now,
    runState: 'running',
    scope: config.scope,
    budgets: config.budgets,
    spend: { ...EMPTY_SPEND },
    inventoryRuns: [],
    captureIndex: [],
    assetLookups: [],
    timeline: [],
    items: [],
    events: [],
  };
}

/* -------------------------------------------------------------------------- */
/* inventory                                                                   */
/* -------------------------------------------------------------------------- */

async function runInventory(
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
): Promise<'paused' | null> {
  const last = state.inventoryRuns.at(-1);
  if (last !== undefined && last.outcome === 'complete') return null;

  let resumeKey = last?.outcome === 'continued' ? last.resumeKey : null;
  const filters = config.candidateFilters.map(parseCdxFilter);

  for (;;) {
    const query: CdxQuery = {
      url: config.scope.url,
      matchType: config.scope.matchType,
      from: config.scope.from,
      to: config.scope.to,
      limit: Math.min(config.budgets.maxPages * 4, 1000),
      collapse: 'digest',
      resumeKey,
    };
    const requestUrl = buildCdxUrl(config.provider.cdxEndpoint, query);
    const result = await fetchResource(context, requestUrl, 'index');

    const run: InventoryRun = {
      id: `inventory-${state.inventoryRuns.length + 1}`,
      query,
      requestUrl,
      issuedAt: iso(clock),
      rawResponseHash: null,
      rawResponsePath: null,
      rowCount: 0,
      candidateFilters: [...config.candidateFilters],
      candidateRowCount: 0,
      timelineRowCount: 0,
      resumeKey: null,
      limitReached: false,
      outcome: 'failed',
      failure: null,
    };

    if (!result.ok) {
      run.failure = result.failure;
      run.outcome = 'failed';
      state.inventoryRuns.push(run);
      // An index budget stop is not an index failure; both leave a partial
      // inventory, and the report says which happened.
      if (result.exhausted !== null) {
        run.failure = null;
        run.outcome = 'continued';
        run.resumeKey = resumeKey;
      }
      return null;
    }

    const stored = await store.put(result.response.body);
    run.rawResponseHash = stored.hash;
    run.rawResponsePath = stored.relativePath;

    const decoded = decodeBody(result.response.body, {
      contentType: result.response.headers['content-type'] ?? null,
    });
    const page = parseCdxJson(decoded.text ?? '', query.limit);
    // The status rule is applied here rather than sent upstream: a redirect or
    // an error row is not something to rebuild from, and it is also the
    // evidence of when the URL moved or died, so it is excluded and kept.
    const verdicts = page.rows.map((row) => ({ row, excludedBy: rowExclusion(row, filters) }));
    run.rowCount = page.rows.length;
    run.candidateRowCount = verdicts.filter((verdict) => verdict.excludedBy === null).length;
    run.timelineRowCount = verdicts.length - run.candidateRowCount;
    run.resumeKey = page.resumeKey;
    run.limitReached = page.limitReached;
    run.outcome = page.resumeKey === null ? 'complete' : 'continued';
    state.inventoryRuns.push(run);

    for (const { row, excludedBy } of verdicts) {
      if (excludedBy === null || row.original === '' || row.timestamp === '') continue;
      state.timeline.push({
        originalUrl: row.original,
        timestamp: row.timestamp,
        statusCode: row.statusCode,
        mimetype: row.mimetype,
        digest: row.digest,
        length: row.length,
        excludedBy,
      });
    }

    recordInventoryRows(state, config, verdicts, clock);

    if (page.resumeKey === null) return null;
    if (countKind(state, 'page') >= config.budgets.maxPages) return null;
    resumeKey = page.resumeKey;
  }
}

/**
 * One item per original URL, carrying every capture the inventory offered and
 * whether each one passed the candidate filter. Which capture is requested is
 * decided afterwards, by policy, in `applyCaptureSelection`: captures arrive
 * across paginated runs, so a rule applied row by row would be deciding on a
 * partial set.
 *
 * Every row is also recorded in the capture index, whether or not it becomes
 * an item. The inventory is issued with `matchType=domain`, so it already
 * describes the captures of same-host assets, and keeping them is what lets
 * issue #6 resolve those assets for zero additional index requests.
 */
function recordInventoryRows(
  state: JobState,
  config: ProjectConfig,
  verdicts: readonly { row: CdxRow; excludedBy: string | null }[],
  clock: Clock,
): void {
  for (const { row, excludedBy } of verdicts) {
    if (row.original === '' || row.timestamp === '') continue;
    const candidate = candidateFromRow(row, excludedBy);
    recordCapture(state, row.original, 'inventory', candidate);
    if (!seedsPageItem(row)) continue;
    const existing = state.items.find((item) => item.id === itemId(row.original));
    if (existing !== undefined) {
      if (!existing.capture.alternatives.includes(row.timestamp)) {
        existing.capture.alternatives.push(row.timestamp);
        existing.capture.candidates.push(candidate);
      }
      continue;
    }
    if (countKind(state, 'page') >= config.budgets.maxPages) return;
    state.items.push(
      newItem({
        originalUrl: row.original,
        kind: 'page',
        relation: 'page',
        discoveredFrom: null,
        requestedTimestamp: row.timestamp,
        candidate,
        at: iso(clock),
      }),
    );
  }
}

/**
 * Mimetypes an inventory row must carry to be seeded as a page in its own
 * right. A domain inventory describes the whole host, images and stylesheets
 * included; those rows are captures available to whichever page references
 * them, not documents to start from. Seeding them as pages would spend the
 * page budget on assets and validate an image against the markup rules. An
 * untyped row stays a page, because refusing to seed a URL the provider could
 * not type would silently shrink the inventory.
 */
const MARKUP_MIMETYPES = /^(?:text\/html|application\/xhtml\+xml|text\/plain)\b/i;

function seedsPageItem(row: CdxRow): boolean {
  const mimetype = row.mimetype.trim();
  return mimetype === '' || mimetype === '-' || MARKUP_MIMETYPES.test(mimetype);
}

/** Append one capture to the index entry for a URL, creating it if needed. */
function recordCapture(
  state: JobState,
  originalUrl: string,
  source: IndexedCaptureSet['source'],
  candidate: CaptureCandidate,
): void {
  const entry = captureSetFor(state, originalUrl, source);
  if (entry.candidates.some((existing) => existing.timestamp === candidate.timestamp)) return;
  entry.candidates.push(candidate);
}

function captureSetFor(
  state: JobState,
  originalUrl: string,
  source: IndexedCaptureSet['source'],
): IndexedCaptureSet {
  const key = captureKey(originalUrl);
  const existing = state.captureIndex.find((entry) => captureKey(entry.originalUrl) === key);
  if (existing !== undefined) return existing;
  const created: IndexedCaptureSet = { originalUrl: key, source, candidates: [] };
  state.captureIndex.push(created);
  return created;
}

function findCaptureSet(state: JobState, originalUrl: string): IndexedCaptureSet | undefined {
  const key = captureKey(originalUrl);
  return state.captureIndex.find((entry) => captureKey(entry.originalUrl) === key);
}

function candidateFromRow(row: CdxRow, excludedBy: string | null): CaptureCandidate {
  const length = Number.parseInt(row.length, 10);
  return {
    timestamp: row.timestamp,
    digest: row.digest === '' ? null : row.digest,
    statusCode: row.statusCode === '' ? null : row.statusCode,
    mimetype: row.mimetype === '' ? null : row.mimetype,
    length: Number.isFinite(length) ? length : null,
    excludedBy,
  };
}

/**
 * Apply the declared capture selection policy to every item still waiting on a
 * request. An item that already holds validated bytes is never re-pointed
 * here: the first-choice evidence stands until `runOutcomeReselection` tries a
 * next-best capture after a bad outcome (issue #22).
 *
 * A dependency that has already been resolved against its referring page is
 * left alone. Its target is that page, not the project's declared period
 * bound, and re-running this pass over it on a resume would quietly re-point
 * it at the wrong instant.
 */
export function applyCaptureSelection(state: JobState, config: ProjectConfig): void {
  const target = selectionTarget(state.scope);
  for (const item of state.items) {
    if (item.status !== 'unattempted' || item.capture.candidates.length === 0) continue;
    if (item.capture.resolution !== null) continue;
    const selection = selectCapture(item.capture.candidates, config.selection, target);
    if (selection === null) continue;
    const chosen = item.capture.candidates.find((candidate) => candidate.timestamp === selection.timestamp);
    item.capture.selection = selection;
    item.capture.requestedTimestamp = selection.timestamp;
    item.capture.archiveDigest = chosen?.digest ?? null;
    item.capture.archiveStatus = chosen?.statusCode ?? null;
  }
}

/** Configured seeds are selected even when the inventory did not reach them. */
function seedPageItems(state: JobState, config: ProjectConfig, clock: Clock): void {
  for (const url of config.scope.seedUrls) {
    if (state.items.some((item) => item.id === itemId(url))) continue;
    state.items.push(
      newItem({
        originalUrl: url,
        kind: 'page',
        relation: 'page',
        discoveredFrom: 'configuration seedUrls',
        requestedTimestamp: config.scope.to ?? config.scope.from,
        at: iso(clock),
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* fetch loop                                                                  */
/* -------------------------------------------------------------------------- */

async function runFetchLoop(
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
  signal: (() => ControlSignal) | undefined,
): Promise<'paused' | 'cancelled' | null> {
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index] as WorkItem;
    if (isComplete(item) || item.status === 'failed' || item.status === 'skipped') continue;
    if (item.unattemptedReason === 'out-of-scope') continue;

    const control = signal?.() ?? 'continue';
    if (control !== 'continue') {
      const halted = control === 'pause' ? 'paused' : 'cancelled';
      park(state, control === 'pause' ? 'paused' : 'cancelled');
      state.runState = halted;
      state.events.push({ at: iso(clock), kind: halted, detail: `stopped before ${item.originalUrl}` });
      await saveJob(config.outputDirectory, state);
      return halted;
    }

    const exhausted = await acquireItem(item, state, config, context, store, clock);
    await saveJob(config.outputDirectory, state);
    if (exhausted) {
      park(state, 'budget-exhausted');
      state.runState = 'paused';
      state.events.push({ at: iso(clock), kind: 'paused', detail: 'budget exhausted' });
      await saveJob(config.outputDirectory, state);
      return 'paused';
    }
  }
  return null;
}

/** Returns true when a budget stopped the item, so the run should stop too. */
async function acquireItem(
  item: WorkItem,
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
): Promise<boolean> {
  if (item.capture.resolution === null && item.capture.referringTimestamp !== null) {
    const resolved = await resolveDependencyCapture(item, state, config, context, store, clock);
    if (resolved === 'exhausted') {
      item.status = 'unattempted';
      item.unattemptedReason = 'budget-exhausted';
      item.notes.push('the index budget stopped the capture lookup for this URL before any request');
      return true;
    }
    // A lookup that failed is not evidence that the URL has no captures, so
    // the item is a retryable failure rather than a silent gap.
    if (resolved === 'failed') return false;
  }

  const timestamp = item.capture.requestedTimestamp;
  if (timestamp === null) {
    item.status = 'skipped';
    item.unattemptedReason = 'out-of-scope';
    item.notes.push('no capture timestamp is known for this URL, so no replay URL can be built');
    return false;
  }

  const modifier = replayModifierFor(item.relation);
  const requestUrl = buildReplayUrl(config.provider.replayEndpoint, timestamp, item.originalUrl, modifier);
  const result = await fetchResource(context, requestUrl, 'resource');

  if (!result.ok && result.exhausted !== null) {
    item.status = 'unattempted';
    item.unattemptedReason = 'budget-exhausted';
    item.notes.push(`stopped by the ${result.exhausted} budget`);
    return true;
  }

  item.capture.replayModifier = modifier;

  if (!result.ok) {
    item.status = 'failed';
    item.failure = result.failure;
    item.fetch = {
      requestUrl,
      finalUrl: result.finalUrl,
      httpStatus: result.failure.httpStatus,
      redirectChain: result.redirectChain,
      attempts: result.attempts,
      bytesRead: result.bytesRead,
      bodyLength: 0,
      bodyHash: null,
      storePath: null,
      contentType: null,
      truncated: false,
      retrievedAt: iso(clock),
      validated: false,
      archiveInjection: null,
    };
    return false;
  }

  const { response } = result;
  const served = servedTimestamp(response.headers, result.finalUrl);
  item.capture.servedTimestamp = served;
  item.capture.distanceSeconds = served === null ? null : captureDistanceSeconds(timestamp, served);

  const contentType = response.headers['content-type'] ?? null;
  const decoded = decodeBody(response.body, { contentType });
  item.encoding = encodingRecord(decoded);

  const invalid = validateBody({
    relation: item.relation,
    contentType,
    decoded,
    truncated: response.truncated,
    byteLength: response.body.length,
  });

  // Bytes are stored whether or not they validate: an archive error page is
  // evidence of what the provider served and must stay inspectable.
  const stored = await store.put(response.body);

  item.fetch = {
    requestUrl,
    finalUrl: result.finalUrl,
    httpStatus: response.status,
    redirectChain: result.redirectChain,
    attempts: result.attempts,
    bytesRead: result.bytesRead,
    bodyLength: stored.byteLength,
    bodyHash: stored.hash,
    storePath: stored.relativePath,
    contentType,
    truncated: response.truncated,
    retrievedAt: iso(clock),
    validated: invalid === null,
    archiveInjection: scanForInjection(decoded),
  };

  if (invalid !== null) {
    item.status = 'failed';
    item.failure = invalid;
    return false;
  }

  item.status = 'fetched';
  item.failure = null;
  item.unattemptedReason = null;

  if (item.relation === 'page' || item.relation === 'frame') {
    enqueueDependencies(item, state, config, decoded, clock);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* outcome reselection (issue #22)                                             */
/* -------------------------------------------------------------------------- */

/**
 * After the first-choice captures have been classified, try the next-best
 * unused capture of any page that landed on a confirmed non-content outcome.
 *
 * Ranking is `selectCapture` over the unused candidates — there is no second
 * policy. Each further attempt is an ordinary fetch, charged to the same
 * budgets. The loop stops per page at the configured limit or the first `ok`.
 * A resume sees `reselection.completed` and does not try the same page again.
 */
async function runOutcomeReselection(
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
  signal: (() => ControlSignal) | undefined,
): Promise<'paused' | 'cancelled' | null> {
  await classifyCollection(state, store, config.fidelity);

  for (;;) {
    const pending = state.items.filter((item) => needsOutcomeReselection(item, config.outcomeReselection.maxAttempts));
    if (pending.length === 0) return null;

    let fetchedAnAlternative = false;
    for (const item of pending) {
      const control = signal?.() ?? 'continue';
      if (control !== 'continue') {
        const halted = control === 'pause' ? 'paused' : 'cancelled';
        park(state, control === 'pause' ? 'paused' : 'cancelled');
        state.runState = halted;
        state.events.push({ at: iso(clock), kind: halted, detail: `stopped before reselecting ${item.originalUrl}` });
        await saveJob(config.outputDirectory, state);
        return halted;
      }

      const record = ensureReselectionRecord(item);
      const used = usedReselectionTimestamps(item);
      const target = selectionTarget(state.scope);
      const next = selectUnusedCapture(item.capture.candidates, config.selection, target, used);
      if (next === null) {
        record.completed = true;
        record.stoppedReason = 'no-remaining-alternative';
        await saveJob(config.outputDirectory, state);
        continue;
      }

      const previousOutcome = item.outcome?.outcome ?? 'unattempted';
      const snapshot = snapshotLiveCapture(item);
      pointAtCapture(item, next, previousOutcome);
      const exhausted = await acquireItem(item, state, config, context, store, clock);
      if (exhausted) {
        restoreLiveCapture(item, snapshot);
        record.stoppedReason = 'budget-exhausted';
        park(state, 'budget-exhausted');
        state.runState = 'paused';
        state.events.push({ at: iso(clock), kind: 'paused', detail: 'budget exhausted' });
        await saveJob(config.outputDirectory, state);
        return 'paused';
      }

      fetchedAnAlternative = true;
      record.furtherAttempts += 1;

      if (!isComplete(item)) {
        const failedOutcome = item.failure !== null ? outcomeForFailure(item.failure) : 'http-error';
        const failedDetail =
          item.failure !== null
            ? `${item.failure.kind}: ${item.failure.message}`
            : 'the alternative produced no validated bytes';
        record.attempts.push({
          order: record.attempts.length + 1,
          timestamp: next.timestamp,
          outcome: failedOutcome,
          detail: failedDetail,
        });
        restoreLiveCapture(item, snapshot);
        if (record.furtherAttempts >= config.outcomeReselection.maxAttempts) {
          record.completed = true;
          record.stoppedReason = 'attempt-limit';
        }
        await saveJob(config.outputDirectory, state);
        continue;
      }

      await classifyCollection(state, store, config.fidelity);
      recordAttemptFromItem(item, record, next.timestamp);
      if (item.outcome?.outcome === 'ok') {
        record.completed = true;
        record.stoppedReason = 'ok';
      } else if (record.furtherAttempts >= config.outcomeReselection.maxAttempts) {
        record.completed = true;
        record.stoppedReason = 'attempt-limit';
      }
      await saveJob(config.outputDirectory, state);
    }

    if (fetchedAnAlternative) {
      const halted = await runFetchLoop(state, config, context, store, clock, signal);
      if (halted !== null) return halted;
      await classifyCollection(state, store, config.fidelity);
    } else {
      return null;
    }
  }
}

function needsOutcomeReselection(item: WorkItem, maxAttempts: number): boolean {
  if (item.kind !== 'page') return false;
  const record = item.capture.reselection;
  if (record?.completed === true) return false;
  if ((record?.furtherAttempts ?? 0) >= maxAttempts) return false;
  if (record !== null) return item.outcome?.outcome !== 'ok';
  const outcome = item.outcome?.outcome;
  return outcome !== undefined && RESELECTABLE_OUTCOMES.has(outcome);
}

function ensureReselectionRecord(item: WorkItem): CaptureReselection {
  if (item.capture.reselection !== null) return item.capture.reselection;
  const first: ReselectionAttempt | null =
    item.capture.requestedTimestamp === null || item.outcome === null
      ? null
      : {
          order: 1,
          timestamp: item.capture.requestedTimestamp,
          outcome: item.outcome.outcome,
          detail: item.outcome.detail,
        };
  const record: CaptureReselection = {
    attempts: first === null ? [] : [first],
    furtherAttempts: 0,
    completed: false,
    stoppedReason: null,
  };
  item.capture.reselection = record;
  return record;
}

function usedReselectionTimestamps(item: WorkItem): Set<string> {
  const used = new Set<string>();
  for (const attempt of item.capture.reselection?.attempts ?? []) used.add(attempt.timestamp);
  if (item.capture.requestedTimestamp !== null) used.add(item.capture.requestedTimestamp);
  return used;
}

function recordAttemptFromItem(item: WorkItem, record: CaptureReselection, timestamp: string): void {
  record.attempts.push({
    order: record.attempts.length + 1,
    timestamp,
    outcome: item.outcome?.outcome ?? 'unattempted',
    detail: item.outcome?.detail ?? 'no classification pass has run',
  });
}

interface LiveCaptureSnapshot {
  status: WorkItem['status'];
  unattemptedReason: WorkItem['unattemptedReason'];
  failure: WorkItem['failure'];
  requestedTimestamp: string | null;
  servedTimestamp: string | null;
  distanceSeconds: number | null;
  replayModifier: string;
  selection: WorkItem['capture']['selection'];
  archiveDigest: string | null;
  archiveStatus: string | null;
  fetch: WorkItem['fetch'];
  encoding: WorkItem['encoding'];
  outcome: WorkItem['outcome'];
  fidelity: WorkItem['fidelity'];
  notesLength: number;
}

function snapshotLiveCapture(item: WorkItem): LiveCaptureSnapshot {
  return {
    status: item.status,
    unattemptedReason: item.unattemptedReason,
    failure: item.failure,
    requestedTimestamp: item.capture.requestedTimestamp,
    servedTimestamp: item.capture.servedTimestamp,
    distanceSeconds: item.capture.distanceSeconds,
    replayModifier: item.capture.replayModifier,
    selection: item.capture.selection,
    archiveDigest: item.capture.archiveDigest,
    archiveStatus: item.capture.archiveStatus,
    fetch: item.fetch,
    encoding: item.encoding,
    outcome: item.outcome,
    fidelity: item.fidelity,
    notesLength: item.notes.length,
  };
}

function restoreLiveCapture(item: WorkItem, snapshot: LiveCaptureSnapshot): void {
  item.status = snapshot.status;
  item.unattemptedReason = snapshot.unattemptedReason;
  item.failure = snapshot.failure;
  item.capture.requestedTimestamp = snapshot.requestedTimestamp;
  item.capture.servedTimestamp = snapshot.servedTimestamp;
  item.capture.distanceSeconds = snapshot.distanceSeconds;
  item.capture.replayModifier = snapshot.replayModifier;
  item.capture.selection = snapshot.selection;
  item.capture.archiveDigest = snapshot.archiveDigest;
  item.capture.archiveStatus = snapshot.archiveStatus;
  item.fetch = snapshot.fetch;
  item.encoding = snapshot.encoding;
  item.outcome = snapshot.outcome;
  item.fidelity = snapshot.fidelity;
  item.notes.length = snapshot.notesLength;
}

function pointAtCapture(item: WorkItem, selection: CaptureSelection, previousOutcome: string): void {
  const chosen = item.capture.candidates.find((candidate) => candidate.timestamp === selection.timestamp);
  item.status = 'unattempted';
  item.unattemptedReason = 'queued';
  item.failure = null;
  item.capture.requestedTimestamp = selection.timestamp;
  item.capture.servedTimestamp = null;
  item.capture.distanceSeconds = null;
  item.capture.selection = {
    ...selection,
    reason: `next-best alternative after ${previousOutcome}: ${selection.reason}`,
  };
  item.capture.archiveDigest = chosen?.digest ?? null;
  item.capture.archiveStatus = chosen?.statusCode ?? null;
  item.fetch = null;
  item.encoding = null;
  item.outcome = null;
  item.fidelity = null;
}

/* -------------------------------------------------------------------------- */
/* per-asset capture resolution (issue #6)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rows one page of a per-URL lookup will accept. Further captures are
 * retrieved by following `resumeKey`, up to `assetResolution.maxLookupPages`.
 */
export const ASSET_LOOKUP_LIMIT = 100;

type ResolutionOutcome = 'resolved' | 'failed' | 'exhausted';

/**
 * Resolve one dependency against its own captures.
 *
 * The inventory is the first place to look and usually the only one: it was
 * issued with `matchType=domain`, so the captures of a same-host asset are
 * already on record and resolving from them costs no request at all. A per-URL
 * lookup is issued only when the inventory cannot answer, and each URL is
 * looked up at most once, because the result is recorded in the capture index
 * whether or not it found anything.
 */
async function resolveDependencyCapture(
  item: WorkItem,
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
): Promise<ResolutionOutcome> {
  let entry = findCaptureSet(state, item.originalUrl);
  if (entry === undefined && !inventoryProvesAbsence(state, item.originalUrl)) {
    const outcome = await lookupAssetCaptures(item, state, config, context, store, clock);
    if (outcome !== 'complete') return outcome === 'budget-exhausted' ? 'exhausted' : 'failed';
    entry = findCaptureSet(state, item.originalUrl);
  }

  // Why no capture is known, when none is. Which of the three it is decides
  // what a reader should do about the gap, so it is recorded verbatim.
  const absenceDetail =
    entry === undefined
      ? 'the complete, unbounded inventory of this host describes no capture of this URL, ' +
        'so no per-URL lookup was issued'
      : entry.source === 'targeted-lookup'
        ? 'a per-URL index lookup of this URL returned no capture at all'
        : 'the site inventory describes no capture of this URL';

  const candidates = entry?.candidates ?? [];
  const resolution = resolveAssetCapture({
    referringPageUrl: referringPageUrl(item),
    referringTimestamp: item.capture.referringTimestamp,
    candidates,
    source: entry?.source ?? 'none',
    clusterWindowDays: config.selection.clusterWindowDays,
    windowDays: config.assetResolution.windowDays,
    absenceDetail,
  });

  const chosen = candidates.find((candidate) => candidate.timestamp === resolution.resolvedTimestamp);
  item.capture.resolution = resolution;
  item.capture.candidates = [...candidates];
  item.capture.alternatives = candidates.map((candidate) => candidate.timestamp);
  item.capture.selection = resolution.selection;
  item.capture.requestedTimestamp = resolution.resolvedTimestamp;
  item.capture.archiveDigest = chosen?.digest ?? null;
  item.capture.archiveStatus = chosen?.statusCode ?? null;

  if (resolution.resolvedTimestamp === null) {
    item.notes.push(
      `${resolution.detail}; referenced from ${resolution.referringPageUrl}` +
        `${resolution.referringTimestamp === null ? '' : ` at ${resolution.referringTimestamp}`}` +
        ', and the live web is never consulted for it',
    );
  }
  return 'resolved';
}

/**
 * One per-URL index lookup, unbounded in time and paged through `resumeKey`.
 *
 * The site inventory is bounded by the project's declared period, so a URL
 * missing from it may still be archived outside that period — which is exactly
 * the case issue #6 exists for: a page from one era referencing an asset whose
 * only surviving capture is from another. The lookup therefore drops the
 * period bounds and lets the resolver flag the distance instead.
 *
 * Pagination is the same `resumeKey` continuation `src/cdx.ts` already
 * parses and issues. Each page is a separate index request, charged like any
 * other. `assetResolution.maxLookupPages` is the total cap so one URL cannot
 * spend the whole run.
 */
async function lookupAssetCaptures(
  item: WorkItem,
  state: JobState,
  config: ProjectConfig,
  context: FetchContext,
  store: BodyStore,
  clock: Clock,
): Promise<AssetLookup['outcome']> {
  const query: CdxQuery = {
    url: item.originalUrl,
    matchType: 'exact',
    from: null,
    to: null,
    limit: ASSET_LOOKUP_LIMIT,
    collapse: 'digest',
    resumeKey: null,
  };
  const lookup: AssetLookup = {
    originalUrl: item.originalUrl,
    referringPageUrl: referringPageUrl(item),
    query,
    requestUrl: buildCdxUrl(config.provider.cdxEndpoint, query),
    issuedAt: iso(clock),
    rawResponseHash: null,
    rawResponsePath: null,
    rowCount: 0,
    candidateRowCount: 0,
    pageCount: 0,
    limitReached: false,
    detail: null,
    attempts: 0,
    outcome: 'failed',
    failure: null,
  };

  const filters = config.candidateFilters.map(parseCdxFilter);
  const maxPages = config.assetResolution.maxLookupPages;
  let resumeKey: string | null = null;
  // Created after the first successful page, including an empty one: a recorded
  // negative stops a second lookup, but a budget stop before any page must not
  // look like one. Resuming with a larger budget has to be able to ask again.
  let entry: IndexedCaptureSet | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const pageQuery: CdxQuery = { ...query, resumeKey };
    const requestUrl = buildCdxUrl(config.provider.cdxEndpoint, pageQuery);
    const result = await fetchResource(context, requestUrl, 'index');
    lookup.attempts += result.attempts;

    if (!result.ok) {
      if (lookup.pageCount > 0) {
        // Pages already retrieved are candidates the resolver can use. Reporting
        // this URL as having zero captures would be the false gap this path exists
        // to prevent.
        lookup.limitReached = true;
        lookup.detail =
          result.exhausted === null
            ? `a later page of the capture lookup failed after ${String(lookup.pageCount)} page(s): ${result.failure?.kind ?? 'unknown'}`
            : `the ${result.exhausted} budget stopped the capture lookup after ${String(lookup.pageCount)} page(s); later captures were not retrieved`;
        lookup.outcome = 'complete';
        item.notes.push(lookup.detail);
        state.assetLookups.push(lookup);
        return 'complete';
      }
      // A budget stop before any page is not a failure: nothing was tried, and
      // the item is parked so a resumed run with a larger budget can resolve it.
      lookup.outcome = result.exhausted === null ? 'failed' : 'budget-exhausted';
      lookup.failure = result.failure;
      state.assetLookups.push(lookup);
      if (result.exhausted === null) {
        item.status = 'failed';
        item.failure = result.failure;
        item.notes.push(`the capture lookup for this URL failed: ${result.failure.kind}`);
      }
      return lookup.outcome;
    }

    const stored = await store.put(result.response.body);
    if (lookup.rawResponseHash === null) {
      lookup.rawResponseHash = stored.hash;
      lookup.rawResponsePath = stored.relativePath;
    }
    const decoded = decodeBody(result.response.body, {
      contentType: result.response.headers['content-type'] ?? null,
    });
    const page = parseCdxJson(decoded.text ?? '', pageQuery.limit);
    lookup.pageCount += 1;
    entry ??= captureSetFor(state, item.originalUrl, 'targeted-lookup');
    ingestLookupRows(state, entry, lookup, page.rows, filters);

    if (page.resumeKey === null) {
      lookup.limitReached = page.limitReached;
      lookup.detail = page.limitReached
        ? `the last page filled the ${String(ASSET_LOOKUP_LIMIT)}-row page limit with no continuation key, so later captures may exist`
        : null;
      lookup.outcome = 'complete';
      state.assetLookups.push(lookup);
      return 'complete';
    }

    resumeKey = page.resumeKey;
  }

  lookup.limitReached = true;
  lookup.detail =
    `capped after ${String(lookup.pageCount)} page(s) ` +
    `(assetResolution.maxLookupPages=${String(maxPages)}); later captures were not retrieved`;
  lookup.outcome = 'complete';
  item.notes.push(lookup.detail);
  state.assetLookups.push(lookup);
  return 'complete';
}

function ingestLookupRows(
  state: JobState,
  entry: IndexedCaptureSet,
  lookup: AssetLookup,
  rows: readonly CdxRow[],
  filters: readonly CdxFilter[],
): void {
  for (const row of rows) {
    if (row.original === '' || row.timestamp === '') continue;
    const excludedBy = rowExclusion(row, filters);
    lookup.rowCount += 1;
    if (excludedBy === null) lookup.candidateRowCount += 1;
    else {
      state.timeline.push({
        originalUrl: row.original,
        timestamp: row.timestamp,
        statusCode: row.statusCode,
        mimetype: row.mimetype,
        digest: row.digest,
        length: row.length,
        excludedBy,
      });
    }
    if (entry.candidates.some((candidate) => candidate.timestamp === row.timestamp)) continue;
    entry.candidates.push(candidateFromRow(row, excludedBy));
  }
}

/**
 * Whether the inventory's silence about a URL is proof that it has no
 * captures.
 *
 * It is proof only when the inventory is complete, covers the URL's host and
 * was issued without period bounds. A bounded inventory says nothing about
 * captures outside its bounds, and a partial one says nothing at all, so in
 * both cases the absence is worth one per-URL lookup rather than a gap entry.
 */
function inventoryProvesAbsence(state: JobState, url: string): boolean {
  // The job's own scope, not the configuration's: this asks what the inventory
  // that actually ran covered, which on a resumed job is what is on disk.
  const scope = state.scope;
  if (inventoryPartialReasons(state).length > 0) return false;
  if (scope.from !== null || scope.to !== null) return false;
  if (scope.matchType !== 'domain' && scope.matchType !== 'host') return false;

  const scopeHost = hostOfScope(scope.url);
  const host = hostOf(url);
  if (scopeHost === null || host === null) return false;
  if (scope.matchType === 'host') return host === scopeHost;
  return host === scopeHost || host.endsWith(`.${scopeHost}`);
}

function hostOfScope(value: string): string | null {
  const direct = hostOf(value);
  if (direct !== null) return direct;
  return hostOf(`http://${value}`);
}

function referringPageUrl(item: WorkItem): string {
  return item.discoveredFrom?.split(' ')[0] ?? 'an unrecorded page';
}

function enqueueDependencies(
  page: WorkItem,
  state: JobState,
  config: ProjectConfig,
  decoded: DecodeResult,
  clock: Clock,
): void {
  if (decoded.kind !== 'text' || decoded.text === null) return;
  const hosts =
    config.scope.dependencyHosts.length > 0
      ? config.scope.dependencyHosts
      : [hostOf(page.originalUrl)].filter((host): host is string => host !== null);

  for (const link of discoverLinks(decoded.text, page.originalUrl)) {
    const wanted =
      config.discovery.followRelations.includes(link.relation) ||
      (link.relation === 'link' && config.discovery.followPageLinks);
    if (!wanted) continue;

    const host = hostOf(link.resolvedUrl);
    if (host === null || !hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) continue;
    if (state.items.some((item) => item.id === itemId(link.resolvedUrl))) continue;

    const isPage = link.relation === 'link';
    if (isPage && countKind(state, 'page') >= config.budgets.maxPages) continue;
    if (!isPage && countKind(state, 'dependency') >= config.budgets.maxDependencies) continue;

    state.items.push(
      newItem({
        originalUrl: link.resolvedUrl,
        kind: isPage ? 'page' : 'dependency',
        relation: link.relation,
        discoveredFrom: `${page.originalUrl} ${link.location}`,
        // No capture is chosen here. A dependency is resolved against its own
        // captures when it is acquired, aiming at the page's capture time
        // rather than inheriting it, because the page's timestamp is often not
        // a time this asset was captured at all (issue #6).
        requestedTimestamp: null,
        referringTimestamp: page.capture.servedTimestamp ?? page.capture.requestedTimestamp,
        at: iso(clock),
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function newItem(input: {
  originalUrl: string;
  kind: 'page' | 'dependency';
  relation: LinkRelation | 'page';
  discoveredFrom: string | null;
  requestedTimestamp: string | null;
  /**
   * The inventory row this item came from, with the metadata a selection
   * policy reads. Null for a seed or a discovered dependency, which the
   * inventory never described.
   */
  candidate?: CaptureCandidate;
  /** The capture time of the page that referenced this URL, when there is one. */
  referringTimestamp?: string | null;
  at: string;
}): WorkItem {
  const candidates =
    input.candidate !== undefined
      ? [input.candidate]
      : input.requestedTimestamp === null
        ? []
        : [
            {
              timestamp: input.requestedTimestamp,
              digest: null,
              statusCode: null,
              mimetype: null,
              length: null,
              excludedBy: null,
            },
          ];

  return {
    id: itemId(input.originalUrl),
    originalUrl: input.originalUrl,
    kind: input.kind,
    relation: input.relation,
    discoveredFrom: input.discoveredFrom,
    discoveredAt: input.at,
    localPath: localPathFor(input.originalUrl),
    status: 'unattempted',
    unattemptedReason: 'queued',
    failure: null,
    capture: {
      requestedTimestamp: input.requestedTimestamp,
      servedTimestamp: null,
      distanceSeconds: null,
      replayModifier: replayModifierFor(input.relation),
      alternatives: input.requestedTimestamp === null ? [] : [input.requestedTimestamp],
      candidates,
      selection: null,
      referringTimestamp: input.referringTimestamp ?? null,
      resolution: null,
      archiveDigest: input.candidate?.digest ?? null,
      archiveStatus: input.candidate?.statusCode ?? null,
      reselection: null,
    },
    fetch: null,
    encoding: null,
    outcome: null,
    fidelity: null,
    notes: [],
  };
}

/**
 * Run the defensive strip and record what it found.
 *
 * The stored bytes stay exactly as they arrived: an injected body is still
 * evidence of what the provider served, and rewriting the store would destroy
 * it. The stripped text is a pure function of those bytes and the decoder, so
 * a later stage recomputes it rather than storing a second copy.
 */
function scanForInjection(decoded: DecodeResult): ArchiveInjectionRecord {
  if (decoded.kind !== 'text' || decoded.text === null) {
    return { scanned: false, removedNodes: 0, rules: [], removedCharacters: 0, residualMarkers: [] };
  }
  const stripped = stripArchiveInjection(decoded.text);
  return {
    scanned: true,
    removedNodes: stripped.removals.length,
    rules: [...new Set(stripped.removals.map((removal) => removal.rule))],
    removedCharacters: stripped.removals.reduce((total, removal) => total + removal.characters, 0),
    residualMarkers: stripped.residual,
  };
}

function encodingRecord(decoded: DecodeResult): EncodingRecord {
  return {
    kind: decoded.kind,
    declaredEncoding: decoded.declaredEncoding,
    declaredSource: decoded.declaredSource,
    chosenEncoding: decoded.chosenEncoding,
    chosenSource: decoded.chosenSource,
    detectionConfidence: decoded.detectionConfidence,
    cp1252UpgradeApplied: decoded.cp1252UpgradeApplied,
    declarationOverridden: decoded.declarationOverridden,
    declarationConflict: decoded.declarationConflict,
    replacementCount: decoded.replacementCount,
    replacementRatio: decoded.replacementRatio,
    replacementThreshold: decoded.replacementThreshold,
    degraded: decoded.degraded,
    binaryReason: decoded.binaryReason,
  };
}

function park(state: JobState, reason: 'paused' | 'cancelled' | 'budget-exhausted'): void {
  for (const item of state.items) {
    if (item.status === 'unattempted' && item.unattemptedReason === 'queued') {
      item.unattemptedReason = reason === 'budget-exhausted' ? 'budget-exhausted' : reason;
    }
  }
}

function allSettled(state: JobState): boolean {
  return !state.items.some((item) => item.status === 'unattempted' && item.unattemptedReason === 'queued');
}

function countKind(state: JobState, kind: 'page' | 'dependency'): number {
  return state.items.filter((item) => item.kind === kind).length;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function iso(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
