export {
  decodeBody,
  normalizeEncodingLabel,
  ERA_DEFAULT_ENCODING,
  REPLACEMENT_RATIO_THRESHOLD,
} from './decode.ts';
export type {
  DecodeOptions,
  DecodeResult,
  DeclarationSource,
  EncodingSource,
} from './decode.ts';

export { applyCaptureSelection, runAcquisition } from './acquire.ts';
export type { AcquisitionOptions, AcquisitionResult, ControlSignal } from './acquire.ts';

export { BudgetLedger, DEFAULT_BUDGETS, EMPTY_SPEND } from './budget.ts';
export type { BudgetCheck, BudgetLimit, BudgetSpend, Budgets } from './budget.ts';

export {
  buildCdxUrl,
  parseCdxFilter,
  parseCdxJson,
  partitionRows,
  rowMatchesFilter,
  CDX_FIELDS,
  DEFAULT_CANDIDATE_FILTERS,
  DEFAULT_CDX_ENDPOINT,
} from './cdx.ts';
export type { CdxFilter, CdxPage, CdxQuery, CdxRow, ExcludedRow, RowPartition } from './cdx.ts';
export type { MatchType } from './cdx.ts';

export { captureKey, resolveAssetCapture, DEFAULT_ASSET_RESOLUTION } from './resolve-asset.ts';
export type {
  AssetCaptureSource,
  AssetResolution,
  AssetResolutionConfig,
  AssetResolutionInput,
  DigestObservation,
} from './resolve-asset.ts';

export { selectCapture, selectionTarget, CAPTURE_SELECTION_POLICIES, DEFAULT_SELECTION } from './select.ts';
export type {
  CaptureCandidate,
  CaptureSelection,
  CaptureSelectionPolicy,
  SelectionConfig,
} from './select.ts';

export { hasArchiveInjection, stripArchiveInjection, ARCHIVE_INJECTION_MARKERS } from './toolbar.ts';
export type { InjectionRemoval, StripResult } from './toolbar.ts';

export { createTestClock, systemClock } from './clock.ts';
export type { Clock } from './clock.ts';

export { DEFAULT_DISCOVERY, DEFAULT_PROVIDER, loadProjectConfig, parseProjectConfig } from './config.ts';
export type { DiscoveryConfig, ProjectConfig, ProviderConfig, ScopeConfig } from './config.ts';

export {
  blockedAddressReason,
  checkDestination,
  systemResolver,
  DEFAULT_ALLOWED_PORTS,
} from './destination.ts';
export type { DestinationDecision, DestinationPolicy, DnsResolver } from './destination.ts';

export { discoverLinks, extensionOf, localPathFor, MAX_LINKS_PER_PAGE } from './discover.ts';
export type { DiscoveredLink, LinkRelation } from './discover.ts';

export {
  buildEvidenceReport,
  inventoryPartialReasons,
  summarize,
  writeEvidenceReport,
  EVIDENCE_FILE,
  EVIDENCE_SCHEMA_VERSION,
} from './evidence.ts';
export type {
  AssetResolutionEntry,
  EvidenceReport,
  FailedEntry,
  FetchedEntry,
  GapEntry,
  GapKind,
  IndexedEntry,
  RecoveredFile,
  UnattemptedEntry,
} from './evidence.ts';

export { fetchResource } from './fetch-resource.ts';
export type { FetchContext, FetchResult, RequestKind } from './fetch-resource.ts';

export { createFixtureTransport, loadFixtureManifest } from './fixture-transport.ts';
export type { FixtureManifest, FixtureRule, FixtureTransportHandle } from './fixture-transport.ts';

export {
  findItem,
  isComplete,
  itemId,
  loadJob,
  readJobProjectId,
  referenceEligible,
  saveJob,
  JOB_FILE,
  JOB_STATE_VERSION,
} from './job.ts';
export type {
  ArchiveInjectionRecord,
  AssetLookup,
  CaptureRecord,
  IndexedCaptureSet,
  EncodingRecord,
  FetchRecord,
  InventoryRun,
  JobState,
  RedirectHop,
  TimelineEntry,
  WorkItem,
} from './job.ts';

export {
  failure,
  outcomeForFailure,
  outcomeRecord,
  zeroOutcomeCounts,
  ITEM_OUTCOMES,
  OUTCOME_BY_FAILURE_KIND,
} from './outcomes.ts';
export type {
  Failure,
  FailureKind,
  ItemOutcome,
  OutcomeRecord,
  OutcomeSource,
  UnattemptedReason,
} from './outcomes.ts';

export {
  buildErrorTemplateIndex,
  classifyItem,
  errorTemplateFingerprint,
  frameTargets,
  parkedDomainMarker,
  redirectTarget,
  softNotFoundMarker,
  EMPTY_TEMPLATE_INDEX,
} from './classify.ts';
export type {
  ClassificationContext,
  ClassifyInput,
  ErrorTemplate,
  ErrorTemplateIndex,
  RedirectTarget,
  TemplateObservation,
} from './classify.ts';

export { classifyCollection, reclassifyJob } from './reclassify.ts';
export type { ClassificationSummary, ReclassifyResult } from './reclassify.ts';

export { parseRetryAfter, RateLimiter } from './ratelimit.ts';

export { BodyStore, sha256 } from './store.ts';
export type { StoredObject } from './store.ts';

export { createLiveTransport, DEFAULT_USER_AGENT } from './transport.ts';
export type { HttpRequest, HttpResponse, HttpTransport, TransportOptions } from './transport.ts';

export { validateBody } from './validate.ts';

export {
  archiveErrorMarker,
  buildReplayUrl,
  captureDistanceSeconds,
  parseReplayUrl,
  servedTimestamp,
  expandTimestamp,
  replayModifierFor,
  timestampToIso,
  DEFAULT_REPLAY_ENDPOINT,
  IDENTITY_MODIFIER,
  IFRAME_MODIFIER,
  REPLAY_MODIFIERS,
} from './wayback.ts';
