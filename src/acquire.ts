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
import { buildCdxUrl, parseCdxFilter, parseCdxJson, rowExclusion, type CdxQuery, type CdxRow } from './cdx.ts';
import type { ProjectConfig } from './config.ts';
import { decodeBody, type DecodeResult } from './decode.ts';
import { DEFAULT_ALLOWED_PORTS, type DnsResolver } from './destination.ts';
import { discoverLinks, localPathFor, type LinkRelation } from './discover.ts';
import { buildEvidenceReport, writeEvidenceReport, type EvidenceReport } from './evidence.ts';
import { fetchResource, type FetchContext } from './fetch-resource.ts';
import {
  JOB_STATE_VERSION,
  isComplete,
  itemId,
  loadJob,
  saveJob,
  type ArchiveInjectionRecord,
  type EncodingRecord,
  type InventoryRun,
  type JobState,
  type WorkItem,
} from './job.ts';
import { RateLimiter } from './ratelimit.ts';
import { classifyCollection } from './reclassify.ts';
import { selectCapture, selectionTarget, type CaptureCandidate } from './select.ts';
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

  // Classification is a collection-wide pass over bytes already stored, so it
  // runs once the fetch loop is over and costs no requests. The same pass is
  // what `reclassify` re-runs later.
  await classifyCollection(state, store);
  await saveJob(directory, state);

  const report = buildEvidenceReport(state, config);
  const reportPath = await writeEvidenceReport(directory, report);
  return { state, report, reportPath };
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
 * request. An item that already holds validated bytes is never re-pointed: the
 * acquired evidence stands, and reselecting it is an explicit later step.
 */
export function applyCaptureSelection(state: JobState, config: ProjectConfig): void {
  const target = selectionTarget(state.scope);
  for (const item of state.items) {
    if (item.status !== 'unattempted' || item.capture.candidates.length === 0) continue;
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
        // The dependency is asked for at the page's capture time. The provider
        // may answer with a neighbouring capture; the redirect chain and the
        // served timestamp record that. Per-asset nearest-capture resolution
        // is issue #6.
        requestedTimestamp: page.capture.servedTimestamp ?? page.capture.requestedTimestamp,
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
      archiveDigest: input.candidate?.digest ?? null,
      archiveStatus: input.candidate?.statusCode ?? null,
    },
    fetch: null,
    encoding: null,
    outcome: null,
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
