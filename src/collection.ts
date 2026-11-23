/**
 * A collection: the recovered bodies a site model is built from.
 *
 * Acquisition produces a job and a content-addressed store. A site model only
 * needs the part of that which survived validation: which original URL, which
 * capture, which bytes. This module is that narrowing, plus a portable manifest
 * for evidence that was gathered outside a job (docs/SITE-MODEL.md).
 *
 * Nothing here opens a socket. Loading verifies every body against its
 * recorded SHA-256, so a model can never be built from bytes that changed
 * after they were recorded.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { JOB_FILE, referenceEligible, type JobState } from './job.ts';
import { BodyStore, sha256 } from './store.ts';

export const COLLECTION_MANIFEST_VERSION = 1;

export interface CollectionPeriod {
  /** Inclusive 14-digit capture timestamps. */
  from: string;
  to: string;
}

export interface CollectionResource {
  originalUrl: string;
  contentType: string | null;
  /** The capture time the provider actually served, 14 digits. */
  servedTimestamp: string;
  /** Local SHA-256 of exactly the stored bytes. */
  sha256: string;
  byteLength: number;
  /** Absolute path of the stored body. */
  bodyPath: string;
  /**
   * Why a capture outside the declared period was admitted. A resource
   * outside the period without a reason is refused at load time.
   */
  provenance: string | null;
}

export interface Collection {
  id: string;
  period: CollectionPeriod | null;
  source: 'job' | 'manifest';
  resources: CollectionResource[];
}

const TIMESTAMP = /^\d{14}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The identity a site model links by.
 *
 * Acquisition keeps `http://www.example.com:80/a` and `http://example.com/a`
 * as separate records because the archive indexes them separately. A visitor
 * saw one page, so the model treats scheme, a leading `www.`, a default port
 * and the fragment as aliases. Path case and the query string stay, because
 * old servers distinguished them.
 */
export function siteKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const defaultPort = parsed.port === '' || parsed.port === '80' || parsed.port === '443';
  return `${host}${defaultPort ? '' : `:${parsed.port}`}${parsed.pathname}${parsed.search}`;
}

export function inPeriod(timestamp: string, period: CollectionPeriod | null): boolean {
  return period === null || (timestamp >= period.from && timestamp <= period.to);
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function requireString(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string' || value === '') fail(source, `${field} must be a non-empty string`);
  return value;
}

function parsePeriod(value: unknown, source: string): CollectionPeriod | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') fail(source, 'period must be an object');
  const record = value as Record<string, unknown>;
  const from = requireString(record['from'], source, 'period.from');
  const to = requireString(record['to'], source, 'period.to');
  if (!TIMESTAMP.test(from) || !TIMESTAMP.test(to) || from > to) {
    fail(source, 'period.from and period.to must be ordered 14-digit timestamps');
  }
  return { from, to };
}

async function verifiedResource(
  entry: CollectionResource,
  period: CollectionPeriod | null,
  source: string,
): Promise<CollectionResource> {
  if (!TIMESTAMP.test(entry.servedTimestamp)) fail(source, `${entry.originalUrl}: servedTimestamp must be 14 digits`);
  if (!SHA256.test(entry.sha256)) fail(source, `${entry.originalUrl}: sha256 must be 64 lowercase hex characters`);
  if (!inPeriod(entry.servedTimestamp, period) && entry.provenance === null) {
    fail(source, `${entry.originalUrl}: capture ${entry.servedTimestamp} is outside the period and has no provenance`);
  }
  const bytes = await readFile(entry.bodyPath).catch(() => null);
  if (bytes === null) fail(source, `${entry.originalUrl}: body ${entry.bodyPath} is missing`);
  if (sha256(bytes) !== entry.sha256) fail(source, `${entry.originalUrl}: body does not match its recorded sha256`);
  return { ...entry, byteLength: bytes.length };
}

/**
 * Load a portable manifest:
 *
 *   { "schemaVersion": 1, "id": "...", "period": { "from", "to" } | null,
 *     "resources": [ { "originalUrl", "path", "contentType",
 *                      "servedTimestamp", "sha256", "provenance"? } ] }
 *
 * `path` is absolute or relative to the manifest's own directory.
 */
export async function loadCollectionManifest(manifestPath: string): Promise<Collection> {
  const source = manifestPath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail(source, `not readable JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) fail(source, 'manifest must be an object');
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== COLLECTION_MANIFEST_VERSION) {
    fail(source, `schemaVersion must be ${COLLECTION_MANIFEST_VERSION}`);
  }
  const id = requireString(record['id'], source, 'id');
  const period = parsePeriod(record['period'], source);
  if (!Array.isArray(record['resources'])) fail(source, 'resources must be an array');

  const base = dirname(resolve(manifestPath));
  const resources: CollectionResource[] = [];
  for (const raw of record['resources'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null) fail(source, 'every resource must be an object');
    const item = raw as Record<string, unknown>;
    const path = requireString(item['path'], source, 'resource.path');
    const contentType = item['contentType'];
    const provenance = item['provenance'];
    resources.push(
      await verifiedResource(
        {
          originalUrl: requireString(item['originalUrl'], source, 'resource.originalUrl'),
          contentType: typeof contentType === 'string' ? contentType : null,
          servedTimestamp: requireString(item['servedTimestamp'], source, 'resource.servedTimestamp'),
          sha256: requireString(item['sha256'], source, 'resource.sha256'),
          byteLength: 0,
          bodyPath: isAbsolute(path) ? path : join(base, path),
          provenance: typeof provenance === 'string' && provenance !== '' ? provenance : null,
        },
        period,
        source,
      ),
    );
  }
  return { id, period, source: 'manifest', resources };
}

/**
 * Narrow a finished or paused job to its reference-eligible bodies. An item
 * whose outcome is not content (an error page, a parked domain, a soft 404)
 * never reaches a model.
 */
export async function collectionFromJob(state: JobState, directory: string): Promise<Collection> {
  const source = join(directory, JOB_FILE);
  const store = new BodyStore(join(directory, 'store'));
  const period =
    state.scope.from !== null && state.scope.to !== null
      ? { from: state.scope.from.padEnd(14, '0'), to: state.scope.to.padEnd(14, '9') }
      : null;

  const resources: CollectionResource[] = [];
  for (const item of state.items) {
    if (!referenceEligible(item)) continue;
    const hash = item.fetch?.bodyHash ?? null;
    const served = item.capture.servedTimestamp;
    if (hash === null || served === null) continue;
    const outside = !inPeriod(served, period);
    resources.push(
      await verifiedResource(
        {
          originalUrl: item.originalUrl,
          contentType: item.fetch?.contentType ?? null,
          servedTimestamp: served,
          sha256: hash,
          byteLength: 0,
          bodyPath: store.absolutePathFor(hash),
          provenance: outside ? `job capture resolution: ${item.capture.resolution?.source ?? 'unrecorded'}` : null,
        },
        period,
        source,
      ),
    );
  }
  return { id: state.projectId, period, source: 'job', resources };
}
