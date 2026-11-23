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

export { applyCaptureSelection, runAcquisition, ASSET_LOOKUP_LIMIT } from './acquire.ts';
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

export {
  selectCapture,
  selectUnusedCapture,
  selectionTarget,
  CAPTURE_SELECTION_POLICIES,
  DEFAULT_SELECTION,
} from './select.ts';
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

export {
  DEFAULT_DISCOVERY,
  DEFAULT_OUTCOME_RESELECTION,
  DEFAULT_PROVIDER,
  loadProjectConfig,
  parseProjectConfig,
} from './config.ts';
export type {
  DiscoveryConfig,
  OutcomeReselectionConfig,
  ProjectConfig,
  ProviderConfig,
  ScopeConfig,
} from './config.ts';

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
  loadEvidenceRevisions,
  summarize,
  writeEvidenceReport,
  EVIDENCE_FILE,
  EVIDENCE_SCHEMA_VERSION,
} from './evidence.ts';
export type {
  AssetResolutionEntry,
  EvidenceReport,
  FidelityDigest,
  FailedEntry,
  FetchedEntry,
  GapEntry,
  GapKind,
  IndexedEntry,
  RecoveredFile,
  UnattemptedEntry,
} from './evidence.ts';

export {
  defaultRevisions,
  fixtureRevisionFromPath,
  fixtureRevisionOf,
  CODE_REVISION,
} from './revision.ts';
export type { EvidenceRevisions } from './revision.ts';

export { fetchResource } from './fetch-resource.ts';
export type { FetchContext, FetchResult, RequestKind } from './fetch-resource.ts';

export { createFixtureTransport, loadFixtureManifest } from './fixture-transport.ts';
export type { FixtureManifest, FixtureRule, FixtureTransportHandle } from './fixture-transport.ts';

export {
  findItem,
  isComplete,
  itemId,
  loadJob,
  promotableAsReference,
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
  CaptureReselection,
  IndexedCaptureSet,
  EncodingRecord,
  FetchRecord,
  InventoryRun,
  JobState,
  RedirectHop,
  ReselectionAttempt,
  ReselectionStopReason,
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
  RESELECTABLE_OUTCOMES,
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

export { classifyCollection, reclassifyJob, zeroFidelitySummary } from './reclassify.ts';
export type { ClassificationSummary, FidelitySummary, ReclassifyResult } from './reclassify.ts';

export {
  bandFor,
  buildSegmentFrequency,
  crossCaptureAgreement,
  scoreItem,
  segmentsOf,
  weakestSignal,
  ASSET_CREDIT,
  DEFAULT_FIDELITY,
  DEFAULT_FIDELITY_THRESHOLDS,
  DEFAULT_FIDELITY_TUNING,
  DEFAULT_FIDELITY_WEIGHTS,
  FIDELITY_SIGNALS,
} from './fidelity.ts';
export type {
  AssetSummary,
  CrossCaptureAgreement,
  CrossCaptureState,
  FidelityBand,
  FidelityConfig,
  FidelityContext,
  FidelityInput,
  FidelityOverride,
  FidelityScore,
  FidelitySignal,
  FidelitySignalName,
  FidelityThresholds,
  FidelityTuning,
  FidelityWeights,
} from './fidelity.ts';

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

export {
  collectionFromJob,
  inPeriod,
  loadCollectionManifest,
  siteKey,
  COLLECTION_MANIFEST_VERSION,
} from './collection.ts';
export type { Collection, CollectionPeriod, CollectionResource } from './collection.ts';

export {
  buildSiteModel,
  chooseByKey,
  structuralSimilarity,
  structuralSkeleton,
  summarizeSiteModel,
  visibleText,
  writeSiteModel,
  FAMILY_SIMILARITY_THRESHOLD,
  SITE_MODEL_FILE,
  SITE_MODEL_SCHEMA_VERSION,
} from './site-model.ts';
export type {
  AssetOccurrence,
  BodyReader,
  ExternalDestination,
  LinkTargetKind,
  ModelAsset,
  ModelFamily,
  ModelGap,
  ModelGapKind,
  ModelLink,
  ModelPage,
  NavigationEdge,
  SiteModel,
  StaticFeature,
  StaticFeatureKind,
} from './site-model.ts';

export {
  buildReferenceBundle,
  collectionResponder,
  loadReferenceBundle,
  selectReferencePages,
  signOffReferenceBundle,
  summarizeReferenceBundle,
  verifyReferenceBundle,
  DEFAULT_VIEWPORT,
  MAX_ANCHORS_PER_PAGE,
  REFERENCE_BUNDLE_FILE,
  REFERENCE_SCHEMA_VERSION,
  REFERENCE_SIGNOFF_FILE,
} from './reference.ts';
export type {
  Anchor,
  BuildReferenceOptions,
  BundleVerification,
  PageSelection,
  Rect,
  ReferenceBundle,
  ReferenceRenderer,
  ReferenceSignoff,
  ReferenceState,
  RenderConditions,
  RenderRequest,
  RenderResult,
  RequestDisposition,
  RequestRecord,
  RequestResponder,
  ResponderAnswer,
} from './reference.ts';

export { createChromiumRenderer } from './render-chromium.ts';

export { compareImages, decodePng, encodePng } from './png.ts';
export type { Image, PixelComparison } from './png.ts';

export {
  candidatePathOf,
  candidateResponder,
  candidateUrlFor,
  loadCandidate,
  CANDIDATE_ORIGIN,
  CANDIDATE_SITE_DIRECTORY,
  URL_MAP_FILE,
  URL_MAP_SCHEMA_VERSION,
} from './candidate.ts';
export type { Candidate, UrlMapEntry } from './candidate.ts';

export {
  evaluateCandidate,
  summarizeEvaluation,
  DEFAULT_ACCEPTANCE,
  EVALUATION_FILE,
  EVALUATION_SCHEMA_VERSION,
} from './evaluate.ts';
export type {
  AcceptanceThresholds,
  CheckName,
  CheckResult,
  EvaluateOptions,
  EvaluationReport,
  StateEvaluation,
  Verdict,
} from './evaluate.ts';

export {
  summarizeGeneration,
  transcribePage,
  replaceTags,
  transcribeSite,
  GAP_DIRECTORY,
  GENERATION_FILE,
  GENERATION_SCHEMA_VERSION,
} from './transcribe.ts';
export type { GenerationRecord, PageTransformation, TranscribeOptions } from './transcribe.ts';

export { createScriptedProvider } from './provider.ts';
export type { ModelImage, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage, ScriptedAnswer } from './provider.ts';

export {
  extractDocument,
  modernizeSite,
  refreshDirectives,
  rewriteBrief,
  staticProblems,
  submitRewrite,
  summarizeSubmission,
  SUBMISSIONS_DIRECTORY,
  summarizeModernization,
  DEFAULT_MODERNIZE_BUDGETS,
  MODERNIZATION_FILE,
  MODERNIZATION_SCHEMA_VERSION,
  PROMPT_TEMPLATE_VERSION,
} from './modernize.ts';
export type {
  AttemptRecord,
  ModernizationRecord,
  ModernizeBudgets,
  ModernizedPage,
  ModernizeOptions,
  PageOutcome,
  SubmissionRecord,
  SubmissionResult,
  SubmitOptions,
} from './modernize.ts';
