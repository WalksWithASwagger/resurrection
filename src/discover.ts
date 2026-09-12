/**
 * Dependency discovery and local path mapping.
 *
 * Discovery produces records, not files. A discovered URL is a lead until its
 * bytes have been acquired and validated; nothing here may be reported as a
 * recovered file (docs/SPEC.md section 5.3).
 *
 * Extraction is a bounded scan over decoded markup rather than a full parse.
 * It is deliberately conservative about what it treats as a dependency, and
 * every match records where it was found so evidence can point back at it.
 *
 * Markup is untrusted data. Nothing extracted here is ever executed or treated
 * as an instruction (agentic/contract.json, safety.archived_content_is_data).
 */

import { createHash } from 'node:crypto';

export type LinkRelation =
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'media'
  | 'frame'
  | 'object'
  | 'document'
  | 'link';

export interface DiscoveredLink {
  rawUrl: string;
  resolvedUrl: string;
  relation: LinkRelation;
  /** The attribute the URL came from, for the evidence trail. */
  location: string;
}

/** Caps the work one hostile or generated page can create. */
export const MAX_LINKS_PER_PAGE = 500;

const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'rtf', 'txt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
  'zip', 'gz', 'tar', 'sit', 'hqx', 'rss', 'xml', 'mp3', 'wav', 'aif', 'aiff',
  'mov', 'mpg', 'mpeg', 'avi', 'wmv', 'ram', 'rm', 'swf',
]);

interface AttributeRule {
  tag: RegExp;
  attribute: string;
  relation: LinkRelation;
}

const RULES: readonly AttributeRule[] = [
  { tag: /<link\b[^>]*>/gi, attribute: 'href', relation: 'stylesheet' },
  { tag: /<script\b[^>]*>/gi, attribute: 'src', relation: 'script' },
  { tag: /<img\b[^>]*>/gi, attribute: 'src', relation: 'image' },
  { tag: /<input\b[^>]*>/gi, attribute: 'src', relation: 'image' },
  { tag: /<body\b[^>]*>/gi, attribute: 'background', relation: 'image' },
  { tag: /<t[dhr]\b[^>]*>/gi, attribute: 'background', relation: 'image' },
  { tag: /<(?:frame|iframe)\b[^>]*>/gi, attribute: 'src', relation: 'frame' },
  { tag: /<(?:embed|object)\b[^>]*>/gi, attribute: 'src', relation: 'object' },
  { tag: /<object\b[^>]*>/gi, attribute: 'data', relation: 'object' },
  { tag: /<(?:audio|video|source)\b[^>]*>/gi, attribute: 'src', relation: 'media' },
  { tag: /<a\b[^>]*>/gi, attribute: 'href', relation: 'link' },
  { tag: /<area\b[^>]*>/gi, attribute: 'href', relation: 'link' },
];

function attributeValue(tag: string, attribute: string): string | null {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const match = pattern.exec(tag);
  const raw = match?.[1];
  if (raw === undefined) return null;
  return decodeEntities(raw.replace(/^["']|["']$/g, '')).trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function baseHref(html: string, documentUrl: string): string {
  const tag = /<base\b[^>]*>/i.exec(html)?.[0];
  if (tag === undefined) return documentUrl;
  const href = attributeValue(tag, 'href');
  if (href === null) return documentUrl;
  try {
    return new URL(href, documentUrl).toString();
  } catch {
    return documentUrl;
  }
}

export function extensionOf(url: string): string {
  const path = url.split(/[?#]/)[0] ?? '';
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

/** A link whose target is a file to download rather than a page to follow. */
function refineRelation(relation: LinkRelation, resolved: string): LinkRelation {
  if (relation !== 'link') return relation;
  return DOCUMENT_EXTENSIONS.has(extensionOf(resolved)) ? 'document' : 'link';
}

export function discoverLinks(html: string, documentUrl: string): DiscoveredLink[] {
  const base = baseHref(html, documentUrl);
  const found: DiscoveredLink[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    for (const tag of html.match(rule.tag) ?? []) {
      if (found.length >= MAX_LINKS_PER_PAGE) return found;
      const raw = attributeValue(tag, rule.attribute);
      if (raw === null || raw === '') continue;
      if (/^(?:javascript|mailto|data|about|tel|ftp|news):/i.test(raw)) continue;
      if (raw.startsWith('#')) continue;

      let resolved: string;
      try {
        const url = new URL(raw, base);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        url.hash = '';
        resolved = url.toString();
      } catch {
        continue;
      }

      const relation = refineRelation(rule.relation, resolved);
      const key = `${relation} ${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ rawUrl: raw, resolvedUrl: resolved, relation, location: `<${tagName(tag)} ${rule.attribute}>` });
    }
  }
  return found;
}

function tagName(tag: string): string {
  return /<\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase() ?? 'tag';
}

const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

function safeSegment(segment: string): string {
  const cleaned = segment.replace(UNSAFE_SEGMENT, '_').replace(/^\.+/, '_');
  if (cleaned === '' || cleaned === '_') return '_';
  return cleaned.slice(0, 96);
}

/**
 * Map an original URL to a relative path inside the export.
 *
 * Query strings are part of a historical URL's identity, so they are preserved
 * as a short suffix rather than dropped, and two URLs that differ only by
 * query never collide on one file. Traversal, absolute roots and control
 * characters cannot survive segment sanitisation.
 */
export function localPathFor(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `site/_unparseable/${shortHash(rawUrl)}`;
  }

  const host = safeSegment(url.hostname);
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(safeSegment);

  let last = segments.pop() ?? '';
  if (last === '' || !last.includes('.')) {
    if (last !== '') segments.push(last);
    last = 'index.html';
  }
  if (url.search !== '') {
    const dot = last.lastIndexOf('.');
    const stem = dot === -1 ? last : last.slice(0, dot);
    const extension = dot === -1 ? '' : last.slice(dot);
    last = `${stem}__q${shortHash(url.search)}${extension}`;
  }
  return ['site', host, ...segments, last].join('/');
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
