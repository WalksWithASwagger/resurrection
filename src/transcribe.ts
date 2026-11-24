/**
 * The transcribing generator: a candidate built from the recovered markup
 * itself, with no model call (docs/GENERATION.md).
 *
 * It is the baseline the generation loop starts from and the proof that the
 * pipeline runs end to end without an AI provider (docs/SPEC.md section 6).
 * It does not modernise anything. It makes recovered pages portable: local
 * files, relative links, UTF-8, no archived script, and every missing or
 * external dependency recorded and left unloaded, as it was in the reference.
 *
 * Markup is untrusted data. Archived scripts and inline handlers are removed,
 * never executed and never carried into the candidate.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import { CANDIDATE_SITE_DIRECTORY, URL_MAP_FILE, URL_MAP_SCHEMA_VERSION, type UrlMapEntry } from './candidate.ts';
import { siteKey, type Collection, type CollectionResource } from './collection.ts';
import { decodeBody } from './decode.ts';
import { localPathFor, shortHash } from './discover.ts';
import { CODE_REVISION } from './revision.ts';
import { chooseByKey, type SiteModel } from './site-model.ts';
import { stripArchiveInjection } from './toolbar.ts';

export const GENERATION_FILE = 'generation.json';
export const GENERATION_SCHEMA_VERSION = 1;
export const GAP_DIRECTORY = '_gaps';
/**
 * A source that fails to load without a request. A recovered page renders a
 * missing resource as a broken image, whose size comes from its attributes
 * and alt text; a loadable placeholder would have its own size and move the
 * layout. `data:,` keeps the broken state and never reaches the network.
 */
const UNLOADED_RESOURCE = 'data:,';

/** A 1x1 transparent GIF. Stands in for an image that was not recovered. */

export interface PageTransformation {
  originalUrl: string;
  path: string;
  scriptsRemoved: number;
  handlersRemoved: number;
  linksRewritten: number;
  /** Same-site page links sent to a gap notice. */
  gapLinks: number;
  /** Same-site resources that were not recovered, left unloaded. */
  missingResources: string[];
  /** Resources on other hosts, left unloaded. Never fetched. */
  omittedExternalResources: string[];
}

export interface GenerationRecord {
  schemaVersion: number;
  codeRevision: string;
  generator: 'transcribe';
  /** No model was called. */
  model: null;
  collectionDigest: string;
  pages: PageTransformation[];
  assets: number;
  gapNotices: number;
}

/**
 * Attributes that hold a URL, by tag. Kept in step with the discovery rules
 * in src/discover.ts, so everything discovery counts as a dependency is
 * rewritten here.
 */
const URL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'], area: ['href'], link: ['href'], img: ['src'], input: ['src'], body: ['background'],
  table: ['background'], td: ['background'], th: ['background'], tr: ['background'], frame: ['src'],
  iframe: ['src'], embed: ['src'], object: ['data', 'src'], audio: ['src'], video: ['src'], source: ['src'],
};
/** Tags whose URL is a resource the page loads, not a place a visitor goes. */
const RESOURCE_TAGS = new Set(['link', 'img', 'input', 'body', 'table', 'td', 'th', 'tr', 'embed', 'object', 'audio', 'video', 'source']);

function sitePathFor(key: string, singleHost: boolean): string {
  const path = localPathFor(`http://${key}`).slice('site/'.length);
  return singleHost ? path.slice(path.indexOf('/') + 1) : path;
}

/**
 * A folder URL and its index file name the same local file. When both were
 * recovered with the same bytes they share it. When the bytes differ, as when
 * a cover was edited between captures, the explicit file keeps the plain name
 * and the folder URL gets its own, so neither recovered version is lost.
 *
 * A page served as HTML from a name that does not say so, such as a `.cgi`
 * script, gets `.html` appended: a static host picks the content type from
 * the file name and would otherwise offer the page as a download.
 */
function assignPaths(keys: readonly string[], chosen: ReadonlyMap<string, CollectionResource>, singleHost: boolean): Map<string, string> {
  const pathByKey = new Map<string, string>();
  const occupant = new Map<string, string>();
  const ordered = [...keys.filter((key) => !key.endsWith('/')), ...keys.filter((key) => key.endsWith('/'))];
  for (const key of ordered) {
    let path = sitePathFor(key, singleHost);
    if (/html/i.test(chosen.get(key)?.contentType ?? '') && !/\.html?$/i.test(path)) path += '.html';
    const holder = occupant.get(path);
    if (holder !== undefined && chosen.get(holder)?.sha256 !== chosen.get(key)?.sha256) {
      const dot = path.lastIndexOf('.');
      path = `${path.slice(0, dot)}__${shortHash(key)}${path.slice(dot)}`;
    }
    if (!occupant.has(path)) occupant.set(path, key);
    pathByKey.set(key, path);
  }
  return pathByKey;
}

function relativeFrom(fromPath: string, toPath: string): string {
  const relative = posix.relative(posix.dirname(fromPath), toPath);
  return relative === '' ? posix.basename(toPath) : relative;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

interface Rewriter {
  pagePath: string;
  baseUrl: string;
  /** The page carries a base element, so even `#fragment` resolves against it. */
  hasBase: boolean;
  pathByKey: ReadonlyMap<string, string>;
  siteHosts: ReadonlySet<string>;
  gapNotices: Map<string, string>;
  record: PageTransformation;
}

/** Where a URL attribute should point in the candidate, or null to leave it alone. */
function rewrittenUrl(raw: string, isResource: boolean, context: Rewriter): string | null {
  const value = decodeAttribute(raw).trim();
  // A fragment-only link stays on the page, unless a base element sent it elsewhere.
  if (value === '' || (value.startsWith('#') && !context.hasBase)) return null;
  if (/^javascript:/i.test(value)) return '#';
  if (/^(?:mailto|data|about|tel|ftp|news):/i.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value, context.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const fragment = url.hash;
  url.hash = '';
  const key = siteKey(url.toString());
  const target = context.pathByKey.get(key);
  if (target !== undefined) {
    context.record.linksRewritten += 1;
    return relativeFrom(context.pagePath, target) + fragment;
  }

  const onSite = context.siteHosts.has(key.split('/')[0] ?? key);
  if (isResource) {
    (onSite ? context.record.missingResources : context.record.omittedExternalResources).push(url.toString());
    return UNLOADED_RESOURCE;
  }
  if (!onSite) return url.toString() + fragment;
  context.record.gapLinks += 1;
  const noticePath = `${GAP_DIRECTORY}/${shortHash(key)}.html`;
  context.gapNotices.set(noticePath, url.toString());
  return relativeFrom(context.pagePath, noticePath) + fragment;
}

const ATTRIBUTE = (name: string): RegExp => new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');

/**
 * Replace every start tag the way an HTML tokenizer finds it: a quoted
 * attribute value runs to its closing quote, across any `>` inside it. A
 * value whose quote never closes swallows the rest of the document, as it
 * does in a browser, so that tag is left as it is.
 */
export function replaceTags(html: string, replace: (tag: string) => string): string {
  let output = '';
  let position = 0;
  const opening = /<[a-z]/gi;
  for (let match = opening.exec(html); match !== null; match = opening.exec(html)) {
    const start = match.index;
    let index = start + 1;
    let end = -1;
    let afterEquals = false;
    while (index < html.length) {
      const character = html[index];
      if (character === '>') {
        end = index;
        break;
      }
      if (afterEquals && (character === '"' || character === "'")) {
        const close = html.indexOf(character, index + 1);
        if (close === -1) break;
        index = close + 1;
        afterEquals = false;
        continue;
      }
      if (character === '=') afterEquals = true;
      else if (!/\s/.test(character ?? '')) afterEquals = false;
      index += 1;
    }
    if (end === -1) break;
    output += html.slice(position, start) + replace(html.slice(start, end + 1));
    position = end + 1;
    opening.lastIndex = position;
  }
  return output + html.slice(position);
}

function rewriteTag(tag: string, context: Rewriter): string {
  const name = /^<\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
  let result = tag;

  // Inline handlers are archived script.
  result = result.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
    context.record.handlersRemoved += 1;
    return '';
  });

  for (const attribute of URL_ATTRIBUTES[name] ?? []) {
    result = result.replace(ATTRIBUTE(attribute), (whole, prefix: string, quoted: string) => {
      const raw = quoted.replace(/^["']|["']$/g, '');
      const replacement = rewrittenUrl(raw, RESOURCE_TAGS.has(name), context);
      return replacement === null ? whole : `${prefix}"${escapeAttribute(replacement)}"`;
    });
  }
  return result;
}

function baseUrlOf(html: string, documentUrl: string): string {
  const href = /<base\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(html)?.[1]?.replace(/^["']|["']$/g, '');
  if (href === undefined) return documentUrl;
  try {
    return new URL(decodeAttribute(href), documentUrl).toString();
  } catch {
    return documentUrl;
  }
}

function withUtf8Declaration(html: string): string {
  const cleaned = html.replace(/<meta\b[^>]*\bcharset\s*=[^>]*>/gi, '');
  const declaration = '<meta charset="utf-8">';
  if (/<head\b[^>]*>/i.test(cleaned)) return cleaned.replace(/<head\b[^>]*>/i, (head) => `${head}${declaration}`);
  if (/<html\b[^>]*>/i.test(cleaned)) return cleaned.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${declaration}</head>`);
  return `${declaration}${cleaned}`;
}

/**
 * Transcribe one page. The document mode is left alone on purpose: adding a
 * doctype would move a quirks-mode page into standards mode and change its
 * layout.
 */
export function transcribePage(html: string, context: Rewriter): string {
  const baseUrl = baseUrlOf(html, context.baseUrl);
  const scoped: Rewriter = { ...context, baseUrl, hasBase: /<base\b[^>]*\bhref\s*=/i.test(html) };
  let result = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<script\b[^>]*\/?>/gi, () => {
    context.record.scriptsRemoved += 1;
    return '';
  });
  // With no script left, what a scriptless browser was shown is the page.
  result = result.replace(/<\/?noscript\b[^>]*>/gi, '');
  result = result.replace(/<base\b[^>]*>/gi, '');
  result = replaceTags(result, (tag) => rewriteTag(tag, scoped));
  return withUtf8Declaration(result);
}

function gapNotice(originalUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not recovered</title></head>
<body><h1>Not recovered</h1>
<p>This page was not recovered from the archive. It is a notice added by the reconstruction, not part of the original site.</p>
<p>Original address: <code>${escapeText(originalUrl)}</code></p></body></html>
`;
}

function looksLikeHtml(resource: CollectionResource, text: string): boolean {
  if (/html/i.test(resource.contentType ?? '')) return true;
  if (resource.contentType !== null && resource.contentType !== '') return false;
  return /<(?:!doctype\s+html|html|head|body|frameset)\b/i.test(text.slice(0, 2048));
}

export interface TranscribeOptions {
  collection: Collection;
  model: SiteModel;
  outputDirectory: string;
}

/** Build a candidate directory from a collection. Replaces any candidate already there. */
export async function transcribeSite(options: TranscribeOptions): Promise<GenerationRecord> {
  const { chosen } = chooseByKey(options.collection);
  const keys = [...chosen.keys()].sort();
  const siteHosts = new Set(options.model.siteHosts);
  const singleHost = siteHosts.size === 1;
  const pathByKey = assignPaths(keys, chosen, singleHost);

  const siteRoot = join(options.outputDirectory, CANDIDATE_SITE_DIRECTORY);
  await rm(siteRoot, { recursive: true, force: true });
  const write = async (path: string, content: string | Uint8Array): Promise<void> => {
    const absolute = join(siteRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };

  const gapNotices = new Map<string, string>();
  const pages: PageTransformation[] = [];
  const entries: UrlMapEntry[] = [];
  let assets = 0;
  for (const key of keys) {
    const resource = chosen.get(key) as CollectionResource;
    const path = pathByKey.get(key) as string;
    const bytes = new Uint8Array(await readFile(resource.bodyPath));
    const decoded = decodeBody(bytes, { contentType: resource.contentType });
    entries.push({ originalUrl: resource.originalUrl, path });

    if (decoded.kind === 'text' && decoded.text !== null && looksLikeHtml(resource, decoded.text)) {
      const record: PageTransformation = {
        originalUrl: resource.originalUrl, path, scriptsRemoved: 0, handlersRemoved: 0, linksRewritten: 0,
        gapLinks: 0, missingResources: [], omittedExternalResources: [],
      };
      const html = transcribePage(stripArchiveInjection(decoded.text).text, {
        pagePath: path, baseUrl: resource.originalUrl, hasBase: false, pathByKey, siteHosts, gapNotices, record,
      });
      await write(path, html);
      pages.push(record);
    } else {
      await write(path, bytes);
      assets += 1;
    }
  }

  for (const [path, originalUrl] of [...gapNotices.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await write(path, gapNotice(originalUrl));
  }

  const record: GenerationRecord = {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    codeRevision: CODE_REVISION,
    generator: 'transcribe',
    model: null,
    collectionDigest: options.model.collection.digest,
    pages,
    assets,
    gapNotices: gapNotices.size,
  };
  await writeJson(join(options.outputDirectory, URL_MAP_FILE), { schemaVersion: URL_MAP_SCHEMA_VERSION, entries });
  await writeJson(join(options.outputDirectory, GENERATION_FILE), record);
  return record;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export function summarizeGeneration(record: GenerationRecord): string {
  const sum = (pick: (page: PageTransformation) => number): number => record.pages.reduce((total, page) => total + pick(page), 0);
  return [
    `generated by ${record.generator} (no model call): ${record.pages.length} pages, ${record.assets} assets, ${record.gapNotices} gap notices`,
    `  ${sum((page) => page.linksRewritten)} links rewritten, ${sum((page) => page.gapLinks)} links to unrecovered pages`,
    `  ${sum((page) => page.scriptsRemoved)} scripts and ${sum((page) => page.handlersRemoved)} inline handlers removed`,
    `  ${sum((page) => page.missingResources.length)} missing and ${sum((page) => page.omittedExternalResources.length)} external resources left unloaded`,
    '',
  ].join('\n');
}
