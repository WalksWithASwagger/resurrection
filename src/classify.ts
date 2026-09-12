/**
 * Content-level outcome classification.
 *
 * Bytes are necessary but not sufficient. An archived response can return HTTP
 * 200 and hold no recovered content at all: a Wayback interstitial, the
 * origin's own 404 template replayed as a success, a parked-domain holding
 * page, a soft redirect, or a frameset whose frames were never captured. This
 * module decides which of those an item is, so that a 404 template is never
 * promoted into an M2 reference (issue #5).
 *
 * Everything here is pure and deterministic: the same decoded text and the
 * same collection context always produce the same outcome. No model call, no
 * clock, no I/O, no network. `reclassify.ts` supplies the decoded text by
 * re-reading stored bytes, so reclassifying a collection costs zero requests.
 *
 * Detection is by literal markers and by structure, never by reading page
 * prose for meaning. Archived markup is untrusted data: nothing matched here
 * is executed, followed or treated as an instruction
 * (agentic/contract.json, safety.archived_content_is_data).
 */

import { createHash } from 'node:crypto';

import { discoverLinks } from './discover.ts';
import type { ItemStatus } from './job.ts';
import {
  outcomeForFailure,
  outcomeRecord,
  type Failure,
  type OutcomeRecord,
  type UnattemptedReason,
} from './outcomes.ts';
import { archiveErrorMarker } from './wayback.ts';

/** Marker scans are bounded, so a long capture cannot be scanned into a match. */
const MARKER_WINDOW = 4096;

/**
 * Literal parked-domain and registrar holding-page phrases.
 *
 * Short and literal on purpose. These are the boilerplate a parking provider
 * prints, not a judgement about what a page is "about". Adding one is a
 * deliberate change with a fixture behind it.
 */
const PARKED_DOMAIN_MARKERS: readonly string[] = [
  'this domain is for sale',
  'buy this domain',
  'this domain name is parked',
  'parked free, courtesy of',
  'this domain name has expired',
];

/**
 * Not-found markers, matched only inside `<title>` and `<h1>`.
 *
 * Restricting them to the two elements a 404 template puts its name in keeps
 * this from becoming a heuristic over page prose: a genuine article that
 * mentions a broken link cannot trip it.
 */
const SOFT_404_MARKERS: readonly string[] = ['404', 'not found', 'page cannot be found', 'no such page'];

/** A fingerprint below this many characters is too thin to identify anything. */
const MIN_FINGERPRINT_SOURCE = 24;

/** How much normalized text a template fingerprint covers. */
const FINGERPRINT_SOURCE_CHARS = 2048;

/* -------------------------------------------------------------------------- */
/* error templates                                                             */
/* -------------------------------------------------------------------------- */

export interface ErrorTemplate {
  /** Stable id: the host and the first 12 characters of the fingerprint. */
  id: string;
  host: string;
  fingerprint: string;
  /** The URL whose capture established this template. */
  observedFrom: string;
}

export interface ErrorTemplateIndex {
  byHost: ReadonlyMap<string, readonly ErrorTemplate[]>;
}

export const EMPTY_TEMPLATE_INDEX: ErrorTemplateIndex = { byHost: new Map() };

export interface TemplateObservation {
  originalUrl: string;
  /** The origin's status at crawl time, from the CDX inventory row. */
  archiveStatus: string | null;
  text: string | null;
}

/**
 * A soft 404 is identified by comparison, not by suspicion.
 *
 * The comparison target is the site's own error template, and the only thing
 * that establishes one is the provider's own inventory metadata: a capture the
 * CDX row records as a 4xx at crawl time, whose replayed body is the page the
 * origin served for it. Nothing in the page's prose promotes it to a template.
 */
export function buildErrorTemplateIndex(observations: readonly TemplateObservation[]): ErrorTemplateIndex {
  const byHost = new Map<string, ErrorTemplate[]>();
  for (const observation of observations) {
    if (observation.archiveStatus === null || !observation.archiveStatus.startsWith('4')) continue;
    if (observation.text === null) continue;
    const host = hostOf(observation.originalUrl);
    if (host === null) continue;
    const fingerprint = errorTemplateFingerprint(observation.text);
    if (fingerprint === null) continue;

    const templates = byHost.get(host) ?? [];
    if (templates.some((template) => template.fingerprint === fingerprint)) continue;
    templates.push({
      id: `${host}:${fingerprint.slice(0, 12)}`,
      host,
      fingerprint,
      observedFrom: observation.originalUrl,
    });
    byHost.set(host, templates);
  }
  return { byHost };
}

/**
 * A shape fingerprint for an error template.
 *
 * Two captures of one 404 template differ only in what they echo back: the
 * requested path, a timestamp, a hit counter. Normalization drops URLs, paths
 * and digits and keeps the remaining word shape, so the same template matches
 * across pages while a genuine page does not collide with it. Null when the
 * normalized text is too thin to identify anything.
 */
export function errorTemplateFingerprint(text: string): string | null {
  const normalized = stripMarkup(text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gu, ' ')
    .replace(/\/\S+/gu, ' ')
    .replace(/[^a-z ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, FINGERPRINT_SOURCE_CHARS);
  if (normalized.length < MIN_FINGERPRINT_SOURCE) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* detectors                                                                   */
/* -------------------------------------------------------------------------- */

export interface RedirectTarget {
  raw: string;
  resolved: string;
  mechanism: 'meta-refresh' | 'script-location';
}

const META_REFRESH_TAG = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/giu;
const REFRESH_CONTENT = /content\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/iu;
const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu;
const SCRIPT_LOCATION =
  /(?:window|document|self|top)?\.?location(?:\.href|\.replace)?\s*(?:=|\(\s*)\s*["']([^"']+)["']/iu;

/**
 * A `meta refresh` or a scripted location assignment, with its target.
 *
 * The target is recorded, never followed. Scripted redirects are read only
 * inside `<script>` blocks, so prose that happens to contain the word
 * `location` cannot produce one.
 */
export function redirectTarget(text: string, documentUrl: string): RedirectTarget | null {
  for (const tag of text.matchAll(META_REFRESH_TAG)) {
    const content = REFRESH_CONTENT.exec(tag[0])?.[1];
    if (content === undefined) continue;
    const url = /url\s*=\s*["']?([^"';>]+)/iu.exec(unquote(content))?.[1]?.trim();
    if (url === undefined || url === '') continue;
    return { raw: url, resolved: resolve(url, documentUrl), mechanism: 'meta-refresh' };
  }

  for (const block of text.matchAll(SCRIPT_BLOCK)) {
    const body = block[1];
    if (body === undefined) continue;
    const url = SCRIPT_LOCATION.exec(body)?.[1];
    if (url === undefined || url.trim() === '') continue;
    return { raw: url, resolved: resolve(url, documentUrl), mechanism: 'script-location' };
  }
  return null;
}

/** A literal parked-domain marker in the head window, or null. */
export function parkedDomainMarker(text: string): string | null {
  const head = text.slice(0, MARKER_WINDOW).toLowerCase();
  return PARKED_DOMAIN_MARKERS.find((marker) => head.includes(marker)) ?? null;
}

const TITLE = /<title\b[^>]*>([\s\S]{0,200}?)<\/title\s*>/iu;
const HEADING = /<h1\b[^>]*>([\s\S]{0,200}?)<\/h1\s*>/iu;

/** A not-found marker in the document's title or first heading, or null. */
export function softNotFoundMarker(text: string): string | null {
  const head = text.slice(0, MARKER_WINDOW);
  const labels = [TITLE.exec(head)?.[1], HEADING.exec(head)?.[1]]
    .filter((value): value is string => value !== undefined)
    .map((value) => stripMarkup(value));
  for (const label of labels) {
    const marker = SOFT_404_MARKERS.find((candidate) => label.includes(candidate));
    if (marker !== undefined) return marker;
  }
  return null;
}

/**
 * Frame URLs this document declares, resolved against it.
 *
 * Extraction reuses the acquisition link scanner rather than adding a second
 * markup parser, so a frame is the same thing here as it is during discovery.
 */
export function frameTargets(text: string, documentUrl: string): string[] {
  return discoverLinks(text, documentUrl)
    .filter((link) => link.relation === 'frame')
    .map((link) => link.resolvedUrl);
}

const FRAMESET = /<frameset\b/iu;

/* -------------------------------------------------------------------------- */
/* classification                                                              */
/* -------------------------------------------------------------------------- */

export interface ClassificationContext {
  templates: ErrorTemplateIndex;
  /** Original URLs in this collection that hold validated bytes. */
  capturedUrls: ReadonlySet<string>;
}

export interface ClassifyInput {
  originalUrl: string;
  status: ItemStatus;
  unattemptedReason: UnattemptedReason | null;
  failure: Failure | null;
  /** Bytes arrived and passed M1's response and content validation. */
  validated: boolean;
  /** Decoded text, or null for a binary body or no body at all. */
  text: string | null;
}

/**
 * One item, exactly one outcome.
 *
 * Precedence runs strongest evidence first, so a page carrying two signals is
 * classified by the one that is hardest to fake:
 *
 *   1. the provider's own interstitial markers
 *   2. an exact match against an observed error template for the host
 *   3. a literal parked-domain marker
 *   4. a recorded redirect target
 *   5. a frameset with nothing captured behind it
 *   6. a not-found marker with no template to confirm it
 *   7. otherwise `ok`
 */
export function classifyItem(input: ClassifyInput, context: ClassificationContext): OutcomeRecord {
  if (input.status === 'unattempted') {
    return outcomeRecord(
      'unattempted',
      'unattempted',
      `no request was made: ${input.unattemptedReason ?? 'queued'}`,
    );
  }
  if (input.status === 'skipped') {
    return outcomeRecord('not-archived', 'no-capture', 'no capture is known for this URL');
  }
  if (input.failure !== null) {
    const outcome = outcomeForFailure(input.failure);
    return outcomeRecord(outcome, 'failure', `${input.failure.kind}: ${input.failure.message}`);
  }
  if (!input.validated) {
    return outcomeRecord('http-error', 'failure', 'bytes arrived but did not pass validation');
  }

  // A binary body that validated is what it claims to be. The detectors below
  // read markup; running them on image bytes would answer a question nobody
  // asked.
  if (input.text === null) {
    return outcomeRecord('ok', 'content', 'validated bytes, not markup');
  }
  return classifyText(input.text, input.originalUrl, context);
}

function classifyText(text: string, documentUrl: string, context: ClassificationContext): OutcomeRecord {
  const marker = archiveErrorMarker(text);
  if (marker !== null) {
    return outcomeRecord('archive-interstitial', 'content', `provider marker "${marker}"`);
  }

  const template = matchingTemplate(text, documentUrl, context.templates);
  if (template !== null) {
    return outcomeRecord(
      'origin-soft-404',
      'content',
      `matches the error template observed at ${template.observedFrom}`,
      { matchedTemplate: template.id },
    );
  }

  const parked = parkedDomainMarker(text);
  if (parked !== null) {
    return outcomeRecord('parked-domain', 'content', `holding-page marker "${parked}"`);
  }

  const redirect = redirectTarget(text, documentUrl);
  if (redirect !== null) {
    return outcomeRecord('meta-refresh-redirect', 'content', `${redirect.mechanism} to ${redirect.raw}`, {
      redirectTarget: redirect.resolved,
    });
  }

  if (FRAMESET.test(text)) {
    const frames = frameTargets(text, documentUrl);
    const captured = frames.filter((url) => context.capturedUrls.has(url));
    if (captured.length === 0) {
      return outcomeRecord(
        'frameset-only',
        'content',
        frames.length === 0
          ? 'frameset declares no frames'
          : `none of the ${String(frames.length)} declared frames hold validated bytes`,
      );
    }
  }

  const notFound = softNotFoundMarker(text);
  if (notFound !== null) {
    return outcomeRecord(
      'unverified-soft-404',
      'content',
      `not-found marker "${notFound}" with no observed error template for this host`,
    );
  }

  return outcomeRecord('ok', 'content', 'validated markup with no non-content marker');
}

function matchingTemplate(
  text: string,
  documentUrl: string,
  index: ErrorTemplateIndex,
): ErrorTemplate | null {
  const host = hostOf(documentUrl);
  if (host === null) return null;
  const templates = index.byHost.get(host);
  if (templates === undefined || templates.length === 0) return null;
  const fingerprint = errorTemplateFingerprint(text);
  if (fingerprint === null) return null;
  return templates.find((template) => template.fingerprint === fingerprint) ?? null;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function stripMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/gu, '');
}

function resolve(url: string, documentUrl: string): string {
  try {
    return new URL(url, documentUrl).toString();
  } catch {
    return url;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
