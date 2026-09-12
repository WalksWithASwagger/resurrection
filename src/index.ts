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

export { runAcquisition } from './acquire.ts';
export type { AcquisitionOptions, AcquisitionResult, ControlSignal } from './acquire.ts';

export { BudgetLedger, DEFAULT_BUDGETS, EMPTY_SPEND } from './budget.ts';
export type { BudgetCheck, BudgetLimit, BudgetSpend, Budgets } from './budget.ts';

export { buildCdxUrl, parseCdxJson, CDX_FIELDS, DEFAULT_CDX_ENDPOINT } from './cdx.ts';
export type { CdxPage, CdxQuery, CdxRow, MatchType } from './cdx.ts';

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
  summarize,
  writeEvidenceReport,
  EVIDENCE_FILE,
  EVIDENCE_SCHEMA_VERSION,
} from './evidence.ts';
export type {
  EvidenceReport,
  FailedEntry,
  FetchedEntry,
  GapEntry,
  IndexedEntry,
  RecoveredFile,
  UnattemptedEntry,
} from './evidence.ts';

export { fetchResource } from './fetch-resource.ts';
export type { FetchContext, FetchResult, RequestKind } from './fetch-resource.ts';

export { createFixtureTransport, loadFixtureManifest } from './fixture-transport.ts';
export type { FixtureManifest, FixtureRule, FixtureTransportHandle } from './fixture-transport.ts';

export { findItem, isComplete, itemId, loadJob, saveJob, JOB_FILE, JOB_STATE_VERSION } from './job.ts';
export type {
  CaptureRecord,
  EncodingRecord,
  FetchRecord,
  InventoryRun,
  JobState,
  RedirectHop,
  WorkItem,
} from './job.ts';

export { failure } from './outcomes.ts';
export type { Failure, FailureKind, UnattemptedReason } from './outcomes.ts';

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
  timestampToIso,
  DEFAULT_REPLAY_ENDPOINT,
  IDENTITY_MODIFIER,
} from './wayback.ts';
