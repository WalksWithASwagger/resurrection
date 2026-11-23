/**
 * Reference states: what a recovered page looks like when its archived bytes
 * are rendered under pinned conditions (docs/SPEC.md sections 4 and 8,
 * docs/REFERENCES.md).
 *
 * A reference here is a new render of archived bytes. It is not a historical
 * screenshot and makes no claim about how a browser of the period drew the
 * page; the bundle records its kind so nobody can mistake one for the other.
 *
 * This module is the renderer-independent half: which pages to render, how a
 * request is answered from the collection, and the bundle that freezes the
 * result. The browser lives behind `ReferenceRenderer` so the bundle logic
 * is tested without one.
 *
 * A bundle is frozen by its digest. A sign-off names the digest it approved,
 * so any later change to a screenshot, an anchor or a condition invalidates
 * the sign-off instead of silently riding along with it.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { siteKey, type Collection, type CollectionResource } from './collection.ts';
import { decodeBody } from './decode.ts';
import { CODE_REVISION } from './revision.ts';
import { chooseByKey, type ModelPage, type SiteModel } from './site-model.ts';
import { sha256 } from './store.ts';

export const REFERENCE_BUNDLE_FILE = 'references.json';
export const REFERENCE_SIGNOFF_FILE = 'signoff.json';
export const REFERENCE_SCHEMA_VERSION = 1;

/** Caps what one hostile or generated page can add to a bundle. */
export const MAX_ANCHORS_PER_PAGE = 1500;

export interface RenderConditions {
  browser: string;
  browserVersion: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezone: string;
  colorScheme: 'light';
  /** Page scripts never run in a reference render: archived code is untrusted. */
  javaScriptEnabled: false;
  fullPage: true;
}

export const DEFAULT_VIEWPORT = { width: 1024, height: 768 } as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A measured element. `ordinal` counts elements of the same tag in document order. */
export interface Anchor {
  tag: string;
  ordinal: number;
  rect: Rect;
  /** Link or heading text, an image's source, or empty. Truncated. */
  label: string;
  /** For a link: the absolute URL it resolves to. Null for anything else. */
  target: string | null;
}

export type RequestDisposition =
  /** Answered from the collection. */
  | 'served'
  /** A site URL the collection has no body for. */
  | 'missing'
  /** Not a site URL. Never fetched. */
  | 'blocked-external';

export interface RequestRecord {
  url: string;
  disposition: RequestDisposition;
  /** The body hash for a served request. */
  sha256: string | null;
}

/** What a renderer returns for one page. */
export interface RenderResult {
  screenshot: Uint8Array;
  /** A second capture differed from the first, so the page is not static. */
  screenshotStable: boolean;
  documentSize: { width: number; height: number };
  title: string;
  text: string;
  anchors: Anchor[];
  requests: RequestRecord[];
  /** Uncaught errors raised by page scripts. Always empty when scripts are off. */
  pageErrors: string[];
}

export interface RenderRequest {
  url: string;
  viewport: { width: number; height: number };
  /** Off for archived bytes, which are untrusted. On for a generated candidate. */
  javaScriptEnabled: boolean;
  /** Answers every request the page makes. Never touches the network. */
  respond: RequestResponder;
}

export interface ReferenceRenderer {
  conditions(viewport: { width: number; height: number }): Promise<RenderConditions>;
  render(request: RenderRequest): Promise<RenderResult>;
  close(): Promise<void>;
}

export type ResponderAnswer =
  | { disposition: 'served'; body: Uint8Array; contentType: string | null; sha256: string }
  | { disposition: 'missing' | 'blocked-external' };

export type RequestResponder = (url: string) => Promise<ResponderAnswer>;

/**
 * Answer page requests from a collection. A URL on a site host with no body
 * is `missing`; anything else is `blocked-external`. Nothing is fetched.
 */
/**
 * An undeclared HTML page is served with the encoding the decoder chose.
 * Left alone, Chromium guesses from the bytes, and on short Western pages it
 * can pick a Central European encoding: 0xA9 then reads as a caron letter,
 * not the copyright sign a 2000-era Western browser showed. Serving the
 * decoder's choice keeps the reference and the transcription on one reading.
 */
function servedContentType(contentType: string | null, body: Uint8Array): string | null {
  if (contentType === null || !/^\s*text\/html\b/i.test(contentType) || /charset\s*=/i.test(contentType)) return contentType;
  const decoded = decodeBody(body, { contentType });
  return decoded.chosenEncoding === null ? contentType : `${contentType}; charset=${decoded.chosenEncoding}`;
}

export function collectionResponder(collection: Collection): RequestResponder {
  const { chosen } = chooseByKey(collection);
  const hosts = new Set([...chosen.keys()].map((key) => key.split('/')[0] ?? key));
  return async (url) => {
    const key = siteKey(url);
    const resource: CollectionResource | undefined = chosen.get(key);
    if (resource !== undefined) {
      const body = new Uint8Array(await readFile(resource.bodyPath));
      return { disposition: 'served', body, contentType: servedContentType(resource.contentType, body), sha256: resource.sha256 };
    }
    return { disposition: hosts.has(key.split('/')[0] ?? key) ? 'missing' : 'blocked-external' };
  };
}

export interface ReferenceState {
  pageId: string;
  originalUrl: string;
  familyId: string;
  /** Only the initial state is captured. Interactive states are not implemented. */
  state: 'initial';
  screenshot: { path: string; sha256: string; byteLength: number; stable: boolean };
  documentSize: { width: number; height: number };
  title: string;
  textLength: number;
  textSha256: string;
  anchors: Anchor[];
  anchorsTruncated: boolean;
  requests: RequestRecord[];
}

export interface ReferenceBundle {
  schemaVersion: number;
  codeRevision: string;
  /** A new render of archived bytes, not a screenshot from the period. */
  kind: 'archive-render';
  /** The collection digest of the site model the states were chosen from. */
  modelDigest: string;
  conditions: RenderConditions;
  states: ReferenceState[];
  /** SHA-256 over everything above. A sign-off names this value. */
  digest: string;
}

export interface ReferenceSignoff {
  bundleDigest: string;
  signedBy: string;
  signedAt: string;
  note: string;
}

export type PageSelection = 'representatives' | 'all';

/** Family representatives by default: one page per distinct structure. */
export function selectReferencePages(model: SiteModel, selection: PageSelection): ModelPage[] {
  if (selection === 'all') return model.pages;
  const representatives = new Set(model.families.map((family) => family.representativePageId));
  return model.pages.filter((page) => representatives.has(page.id));
}

function digestOf(bundle: Omit<ReferenceBundle, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

function roundRect(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function sortedRequests(requests: readonly RequestRecord[]): RequestRecord[] {
  const unique = new Map(requests.map((record) => [`${record.disposition} ${record.url}`, record]));
  return [...unique.values()].sort((a, b) => a.url.localeCompare(b.url) || a.disposition.localeCompare(b.disposition));
}

export interface BuildReferenceOptions {
  collection: Collection;
  model: SiteModel;
  renderer: ReferenceRenderer;
  outputDirectory: string;
  selection?: PageSelection;
  viewport?: { width: number; height: number };
}

/** Render the selected pages and write the bundle with its screenshots. */
export async function buildReferenceBundle(options: BuildReferenceOptions): Promise<ReferenceBundle> {
  const viewport = options.viewport ?? { ...DEFAULT_VIEWPORT };
  const respond = collectionResponder(options.collection);
  const conditions = await options.renderer.conditions(viewport);
  const states: ReferenceState[] = [];

  for (const page of selectReferencePages(options.model, options.selection ?? 'representatives')) {
    const result = await options.renderer.render({ url: page.originalUrl, viewport, javaScriptEnabled: false, respond });
    const relativePath = join('states', page.id, 'initial.png');
    const absolute = join(options.outputDirectory, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, result.screenshot);
    states.push({
      pageId: page.id,
      originalUrl: page.originalUrl,
      familyId: page.familyId,
      state: 'initial',
      screenshot: {
        path: relativePath.split('\\').join('/'),
        sha256: sha256(result.screenshot),
        byteLength: result.screenshot.length,
        stable: result.screenshotStable,
      },
      documentSize: result.documentSize,
      title: result.title,
      textLength: result.text.length,
      textSha256: createHash('sha256').update(result.text).digest('hex'),
      anchors: result.anchors.slice(0, MAX_ANCHORS_PER_PAGE).map((anchor) => ({ ...anchor, rect: roundRect(anchor.rect) })),
      anchorsTruncated: result.anchors.length > MAX_ANCHORS_PER_PAGE,
      requests: sortedRequests(result.requests),
    });
  }

  const body: Omit<ReferenceBundle, 'digest'> = {
    schemaVersion: REFERENCE_SCHEMA_VERSION,
    codeRevision: CODE_REVISION,
    kind: 'archive-render',
    modelDigest: options.model.collection.digest,
    conditions,
    states,
  };
  const bundle: ReferenceBundle = { ...body, digest: digestOf(body) };
  await writeJson(join(options.outputDirectory, REFERENCE_BUNDLE_FILE), bundle);
  return bundle;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export async function loadReferenceBundle(directory: string): Promise<ReferenceBundle> {
  return JSON.parse(await readFile(join(directory, REFERENCE_BUNDLE_FILE), 'utf8')) as ReferenceBundle;
}

export interface BundleVerification {
  ok: boolean;
  problems: string[];
  signoff: ReferenceSignoff | null;
  /** A sign-off exists and names this bundle's digest. */
  frozen: boolean;
}

/**
 * Re-derive every hash in a bundle from the files on disk. A bundle is frozen
 * only when it verifies and a sign-off names its digest.
 */
export async function verifyReferenceBundle(directory: string): Promise<BundleVerification> {
  const problems: string[] = [];
  const bundle = await loadReferenceBundle(directory);
  const { digest, ...body } = bundle;
  if (digestOf(body) !== digest) problems.push('bundle digest does not match its contents');
  for (const state of bundle.states) {
    const bytes = await readFile(join(directory, state.screenshot.path)).catch(() => null);
    if (bytes === null) problems.push(`${state.originalUrl}: screenshot ${state.screenshot.path} is missing`);
    else if (sha256(bytes) !== state.screenshot.sha256) problems.push(`${state.originalUrl}: screenshot does not match its recorded hash`);
  }

  let signoff: ReferenceSignoff | null = null;
  const raw = await readFile(join(directory, REFERENCE_SIGNOFF_FILE), 'utf8').catch(() => null);
  if (raw !== null) {
    signoff = JSON.parse(raw) as ReferenceSignoff;
    if (signoff.bundleDigest !== digest) problems.push('sign-off names a different bundle digest');
  }
  const ok = problems.length === 0;
  return { ok, problems, signoff, frozen: ok && signoff !== null };
}

/** Record a human approval of exactly this bundle. Refuses a bundle that does not verify. */
export async function signOffReferenceBundle(
  directory: string,
  approval: { signedBy: string; note: string; signedAt: string },
): Promise<ReferenceSignoff> {
  const bundle = await loadReferenceBundle(directory);
  const signoff: ReferenceSignoff = { bundleDigest: bundle.digest, ...approval };
  await writeJson(join(directory, REFERENCE_SIGNOFF_FILE), signoff);
  const verification = await verifyReferenceBundle(directory);
  if (!verification.ok) throw new Error(`reference bundle does not verify: ${verification.problems.join('; ')}`);
  return signoff;
}

export function summarizeReferenceBundle(bundle: ReferenceBundle): string {
  const { conditions } = bundle;
  const lines = [
    `reference bundle ${bundle.digest.slice(0, 12)} (${bundle.kind}, ${bundle.states.length} states)`,
    `  ${conditions.browser} ${conditions.browserVersion} on ${conditions.platform}, ${conditions.viewport.width}x${conditions.viewport.height} @${conditions.deviceScaleFactor}x, scripts off`,
  ];
  for (const state of bundle.states) {
    const count = (disposition: RequestDisposition): number =>
      state.requests.filter((record) => record.disposition === disposition).length;
    lines.push(
      `  ${state.familyId} ${state.originalUrl}: ${state.documentSize.width}x${state.documentSize.height}, ` +
        `${state.anchors.length} anchors, served ${count('served')}, missing ${count('missing')}, ` +
        `external blocked ${count('blocked-external')}${state.screenshot.stable ? '' : ', NOT STABLE'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
