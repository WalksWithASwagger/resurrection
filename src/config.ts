/**
 * Project configuration.
 *
 * A project declares its scope, its target period, its budgets and its
 * provider. Everything the engine does is driven from this record, so the
 * pipeline has no site-specific branches (roadmap readiness condition R5).
 *
 * This is a system boundary: the file is operator-supplied, so it is validated
 * here and trusted afterwards.
 */

import { readFile } from 'node:fs/promises';

import { DEFAULT_BUDGETS, type Budgets } from './budget.ts';
import { DEFAULT_CANDIDATE_FILTERS, DEFAULT_CDX_ENDPOINT, parseCdxFilter, type MatchType } from './cdx.ts';
import { DEFAULT_REPLAY_ENDPOINT } from './wayback.ts';
import {
  CAPTURE_SELECTION_POLICIES,
  DEFAULT_SELECTION,
  type CaptureSelectionPolicy,
  type SelectionConfig,
} from './select.ts';
import type { LinkRelation } from './discover.ts';

export interface ProviderConfig {
  cdxEndpoint: string;
  replayEndpoint: string;
  /** Hosts the destination guard will permit. The live origin is never one. */
  allowedHosts: string[];
  minRequestIntervalMs: number;
  requestTimeoutMs: number;
}

export interface ScopeConfig {
  /** The historical URL or host the inventory query is built from. */
  url: string;
  matchType: MatchType;
  /** Inclusive CDX timestamp bounds for the target period. */
  from: string | null;
  to: string | null;
  /** Original URLs to select as pages regardless of inventory order. */
  seedUrls: string[];
  /** Only follow dependencies on these hosts. Empty means the scope host. */
  dependencyHosts: string[];
}

export interface DiscoveryConfig {
  followRelations: LinkRelation[];
  /** Follow page links found in acquired pages, not only assets. */
  followPageLinks: boolean;
}

export interface ProjectConfig {
  projectId: string;
  scope: ScopeConfig;
  budgets: Budgets;
  provider: ProviderConfig;
  discovery: DiscoveryConfig;
  /** Which capture is chosen when the inventory offers several. */
  selection: SelectionConfig;
  /**
   * CDX filter expressions an indexed row must satisfy to become an
   * acquisition candidate. A row that fails one is kept as timeline evidence.
   */
  candidateFilters: string[];
  /** Where the job state, object store and reports are written. */
  outputDirectory: string;
}

export const DEFAULT_PROVIDER: ProviderConfig = {
  cdxEndpoint: DEFAULT_CDX_ENDPOINT,
  replayEndpoint: DEFAULT_REPLAY_ENDPOINT,
  allowedHosts: ['web.archive.org'],
  minRequestIntervalMs: 1500,
  requestTimeoutMs: 30_000,
};

export const DEFAULT_DISCOVERY: DiscoveryConfig = {
  followRelations: ['stylesheet', 'script', 'image', 'media', 'frame', 'object', 'document'],
  followPageLinks: false,
};

const MATCH_TYPES: readonly MatchType[] = ['exact', 'prefix', 'host', 'domain'];

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseProjectConfig(raw, path);
}

export function parseProjectConfig(value: unknown, source: string): ProjectConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`project config ${source} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const projectId = requireString(raw['projectId'], 'projectId', source);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId)) {
    throw new Error(`project config ${source}: projectId must be a short lowercase slug`);
  }

  const scopeRaw = requireObject(raw['scope'], 'scope', source);
  const matchType = (scopeRaw['matchType'] ?? 'domain') as MatchType;
  if (!MATCH_TYPES.includes(matchType)) {
    throw new Error(`project config ${source}: matchType must be one of ${MATCH_TYPES.join(', ')}`);
  }

  const scope: ScopeConfig = {
    url: requireString(scopeRaw['url'], 'scope.url', source),
    matchType,
    from: optionalTimestamp(scopeRaw['from'], 'scope.from', source),
    to: optionalTimestamp(scopeRaw['to'], 'scope.to', source),
    seedUrls: stringArray(scopeRaw['seedUrls'], 'scope.seedUrls', source),
    dependencyHosts: stringArray(scopeRaw['dependencyHosts'], 'scope.dependencyHosts', source),
  };

  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...numberRecord(raw['budgets'], 'budgets', source) };
  for (const [key, limit] of Object.entries(budgets)) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`project config ${source}: budgets.${key} must be a positive number`);
    }
  }

  const providerRaw = optionalObject(raw['provider']);
  const provider: ProviderConfig = {
    cdxEndpoint: optionalString(providerRaw['cdxEndpoint'], DEFAULT_PROVIDER.cdxEndpoint),
    replayEndpoint: optionalString(providerRaw['replayEndpoint'], DEFAULT_PROVIDER.replayEndpoint),
    allowedHosts:
      providerRaw['allowedHosts'] === undefined
        ? DEFAULT_PROVIDER.allowedHosts
        : stringArray(providerRaw['allowedHosts'], 'provider.allowedHosts', source),
    minRequestIntervalMs: optionalNumber(
      providerRaw['minRequestIntervalMs'],
      DEFAULT_PROVIDER.minRequestIntervalMs,
      'provider.minRequestIntervalMs',
      source,
    ),
    requestTimeoutMs: optionalNumber(
      providerRaw['requestTimeoutMs'],
      DEFAULT_PROVIDER.requestTimeoutMs,
      'provider.requestTimeoutMs',
      source,
    ),
  };
  if (provider.allowedHosts.length === 0) {
    throw new Error(`project config ${source}: provider.allowedHosts must name at least one archive host`);
  }

  const discoveryRaw = optionalObject(raw['discovery']);
  const discovery: DiscoveryConfig = {
    followRelations:
      discoveryRaw['followRelations'] === undefined
        ? DEFAULT_DISCOVERY.followRelations
        : (stringArray(discoveryRaw['followRelations'], 'discovery.followRelations', source) as LinkRelation[]),
    followPageLinks:
      discoveryRaw['followPageLinks'] === undefined ? false : discoveryRaw['followPageLinks'] === true,
  };

  const selectionRaw = optionalObject(raw['selection']);
  const policy = (selectionRaw['policy'] ?? DEFAULT_SELECTION.policy) as CaptureSelectionPolicy;
  if (!CAPTURE_SELECTION_POLICIES.includes(policy)) {
    throw new Error(
      `project config ${source}: selection.policy must be one of ${CAPTURE_SELECTION_POLICIES.join(', ')}`,
    );
  }
  const clusterWindowDays = optionalNumber(
    selectionRaw['clusterWindowDays'],
    DEFAULT_SELECTION.clusterWindowDays,
    'selection.clusterWindowDays',
    source,
  );
  if (clusterWindowDays <= 0) {
    throw new Error(`project config ${source}: selection.clusterWindowDays must be a positive number`);
  }

  const candidateFilters =
    raw['candidateFilters'] === undefined
      ? [...DEFAULT_CANDIDATE_FILTERS]
      : stringArray(raw['candidateFilters'], 'candidateFilters', source);
  for (const expression of candidateFilters) parseCdxFilter(expression);

  return {
    projectId,
    scope,
    budgets,
    provider,
    discovery,
    selection: { policy, clusterWindowDays },
    candidateFilters,
    outputDirectory: requireString(raw['outputDirectory'], 'outputDirectory', source),
  };
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function optionalNumber(value: unknown, fallback: number, field: string, source: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`project config ${source}: ${field} must be a non-negative number`);
  }
  return value;
}

function requireString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`project config ${source}: ${field} must be a non-empty string`);
  }
  return value;
}

function requireObject(value: unknown, field: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`project config ${source}: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown, field: string, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`project config ${source}: ${field} must be an array of strings`);
  }
  return value as string[];
}

function numberRecord(value: unknown, field: string, source: string): Record<string, number> {
  if (value === undefined) return {};
  const raw = requireObject(value, field, source);
  const numbers: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'number') {
      throw new Error(`project config ${source}: ${field}.${key} must be a number`);
    }
    numbers[key] = entry;
  }
  return numbers;
}

function optionalTimestamp(value: unknown, field: string, source: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4,14}$/.test(value)) {
    throw new Error(`project config ${source}: ${field} must be a CDX timestamp such as 1998 or 19980401000000`);
  }
  return value;
}
