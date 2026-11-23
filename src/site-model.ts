/**
 * The site model: a structured reading of a collection (docs/SPEC.md
 * section 4, docs/SITE-MODEL.md).
 *
 * It is the contract between acquisition and generation. Everything in it is
 * derived from stored bytes by static analysis, so it can say what the markup
 * supports and never that a behavior was observed running. Rendered evidence
 * (reference screenshots, measured anchors) is a separate record that points
 * at this one.
 *
 * The output is deterministic: the same collection and code revision produce
 * byte-identical JSON, with no clock reading and no absolute path in it.
 *
 * Markup is untrusted data. Nothing here executes it or follows instructions
 * found in it.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inPeriod, siteKey, type Collection, type CollectionResource } from './collection.ts';
import { decodeBody } from './decode.ts';
import { discoverLinks, type LinkRelation } from './discover.ts';
import { CODE_REVISION } from './revision.ts';
import { stripArchiveInjection } from './toolbar.ts';

export const SITE_MODEL_FILE = 'site-model.json';
export const SITE_MODEL_SCHEMA_VERSION = 1;

/** Pages whose structural shingle sets overlap at least this much share a family. */
export const FAMILY_SIMILARITY_THRESHOLD = 0.6;
const SHINGLE_LENGTH = 4;
/** Caps the work one hostile or generated page can create. */
const MAX_SKELETON_TAGS = 20_000;

export type LinkTargetKind = 'page' | 'asset' | 'missing' | 'external';

export interface ModelLink {
  rawUrl: string;
  resolvedUrl: string;
  relation: LinkRelation;
  /** The attribute the URL came from. */
  location: string;
  target: LinkTargetKind;
  /** The page or asset id when the target was recovered. */
  targetId: string | null;
}

/**
 * Markup that implies a behavior. `static` is the only evidence level this
 * module can assign: the handler or element is present in the bytes. Whether
 * it ran, and what it looked like, is for a rendered reference to establish.
 */
export type StaticFeatureKind =
  | 'inline-event-handler'
  | 'inline-script'
  | 'external-script'
  | 'form'
  | 'image-map'
  | 'frameset'
  | 'embedded-object'
  | 'meta-refresh'
  | 'background-sound';

export interface StaticFeature {
  kind: StaticFeatureKind;
  evidence: 'static';
  count: number;
  /** The first occurrence, truncated, so a reader can find it in the source. */
  sample: string;
}

export interface ModelPage {
  id: string;
  key: string;
  originalUrl: string;
  servedTimestamp: string;
  sha256: string;
  provenance: string | null;
  title: string | null;
  chosenEncoding: string | null;
  /** The visible text after markup removal: its length and hash are the content assertion. */
  textLength: number;
  textSha256: string;
  familyId: string;
  links: ModelLink[];
  features: StaticFeature[];
  archiveInjectionRemovals: number;
}

export interface AssetOccurrence {
  pageId: string;
  location: string;
}

export interface ModelAsset {
  id: string;
  key: string;
  originalUrl: string;
  contentType: string | null;
  servedTimestamp: string;
  sha256: string;
  byteLength: number;
  provenance: string | null;
  occurrences: AssetOccurrence[];
}

export interface ModelFamily {
  id: string;
  /** The first member in key order; later members were compared against it. */
  representativePageId: string;
  pageIds: string[];
}

export type ModelGapKind =
  /** A same-site page link whose target was not recovered. */
  | 'missing-page'
  /** A same-site image, stylesheet, script, frame or object that was not recovered. */
  | 'missing-asset'
  /** A same-site downloadable document that was not recovered. */
  | 'missing-document'
  /** A recovered body from outside the declared period, admitted with a reason. */
  | 'date-exception'
  /** A second capture of a URL the model already has; kept as a record, not used. */
  | 'unused-variant'
  /** A text body that could not be decoded cleanly. */
  | 'degraded-encoding';

export interface ModelGap {
  kind: ModelGapKind;
  url: string;
  /** Page ids that reference the URL, or an empty list for a collection-level gap. */
  referencedBy: string[];
  detail: string;
}

export interface NavigationEdge {
  from: string;
  to: string;
}

export interface ExternalDestination {
  url: string;
  pageIds: string[];
}

export interface SiteModel {
  schemaVersion: number;
  codeRevision: string;
  collection: {
    id: string;
    source: Collection['source'];
    period: Collection['period'];
    resourceCount: number;
    /** SHA-256 over the sorted (site key, body hash) pairs the model was built from. */
    digest: string;
  };
  /** Hosts the model treats as the site. Links elsewhere are external. */
  siteHosts: string[];
  pages: ModelPage[];
  assets: ModelAsset[];
  families: ModelFamily[];
  navigation: {
    edges: NavigationEdge[];
    /** Pages no other recovered page links to. */
    entryPageIds: string[];
    external: ExternalDestination[];
  };
  gaps: ModelGap[];
}

export type BodyReader = (resource: CollectionResource) => Promise<Uint8Array>;

const readFromDisk: BodyReader = async (resource) => new Uint8Array(await readFile(resource.bodyPath));

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function idFor(key: string): string {
  return hashOf(key).slice(0, 16);
}

function hostOfKey(key: string): string {
  return key.split('/')[0] ?? key;
}

function looksLikeHtml(resource: CollectionResource, text: string): boolean {
  if (/html/i.test(resource.contentType ?? '')) return true;
  if (resource.contentType !== null && resource.contentType !== '') return false;
  return /<(?:!doctype\s+html|html|head|body|frameset)\b/i.test(text.slice(0, 2048));
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function withoutNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

/** Visible text: markup removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  const body = withoutNonContent(html).replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ');
  return decodeEntities(body.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function titleOf(html: string): string | null {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  if (raw === undefined) return null;
  const title = decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title;
}

/**
 * Text-level tags carry wording, not layout, and their count varies with the
 * length of an article. Leaving them out is what lets a short and a long
 * article share a family.
 */
const TEXT_LEVEL_TAGS = new Set([
  'a', 'abbr', 'b', 'big', 'br', 'cite', 'code', 'em', 'font', 'i', 'nobr', 'small', 'span', 'strike', 'strong',
  'sub', 'sup', 'tt', 'u', 'wbr',
]);

/**
 * The structural skeleton: opening tag names in document order, text-level
 * tags dropped and immediate repeats collapsed (twelve paragraphs and three
 * paragraphs are the same structure).
 */
export function structuralSkeleton(html: string): string[] {
  const skeleton: string[] = [];
  const pattern = /<([a-z][a-z0-9]*)\b/gi;
  const source = withoutNonContent(html);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && skeleton.length < MAX_SKELETON_TAGS) {
    const tag = (match[1] as string).toLowerCase();
    if (TEXT_LEVEL_TAGS.has(tag)) continue;
    if (skeleton[skeleton.length - 1] !== tag) skeleton.push(tag);
  }
  return skeleton;
}

function shingles(skeleton: readonly string[]): Set<string> {
  const set = new Set<string>();
  if (skeleton.length < SHINGLE_LENGTH) {
    set.add(skeleton.join('>'));
    return set;
  }
  for (let index = 0; index + SHINGLE_LENGTH <= skeleton.length; index += 1) {
    set.add(skeleton.slice(index, index + SHINGLE_LENGTH).join('>'));
  }
  return set;
}

/** Jaccard similarity of two pages' structural shingle sets, 0 to 1. */
export function structuralSimilarity(a: readonly string[], b: readonly string[]): number {
  const left = shingles(a);
  const right = shingles(b);
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 1 : shared / union;
}

interface FeatureRule {
  kind: StaticFeatureKind;
  pattern: RegExp;
}

const FEATURE_RULES: readonly FeatureRule[] = [
  { kind: 'inline-event-handler', pattern: /<[a-z][^>]*\son(?:mouseover|mouseout|mousedown|mouseup|click|load|change|submit|focus|blur)\s*=[^>]*>/gi },
  { kind: 'inline-script', pattern: /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi },
  { kind: 'external-script', pattern: /<script\b[^>]*\bsrc\s*=[^>]*>/gi },
  { kind: 'form', pattern: /<form\b[^>]*>/gi },
  { kind: 'image-map', pattern: /<map\b[^>]*>/gi },
  { kind: 'frameset', pattern: /<frameset\b[^>]*>/gi },
  { kind: 'embedded-object', pattern: /<(?:embed|object|applet)\b[^>]*>/gi },
  { kind: 'meta-refresh', pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi },
  { kind: 'background-sound', pattern: /<bgsound\b[^>]*>/gi },
];

function staticFeatures(html: string): StaticFeature[] {
  const source = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const features: StaticFeature[] = [];
  for (const rule of FEATURE_RULES) {
    const matches = source.match(rule.pattern);
    if (matches === null) continue;
    features.push({
      kind: rule.kind,
      evidence: 'static',
      count: matches.length,
      sample: (matches[0] as string).replace(/\s+/g, ' ').slice(0, 160),
    });
  }
  return features;
}

interface ParsedPage {
  resource: CollectionResource;
  key: string;
  html: string;
  skeleton: string[];
  chosenEncoding: string | null;
  degraded: boolean;
  removals: number;
}

function gapKindFor(relation: LinkRelation): ModelGapKind {
  if (relation === 'link') return 'missing-page';
  if (relation === 'document') return 'missing-document';
  return 'missing-asset';
}

/** One resource per site key: in-period first, then the earliest capture. */
export function chooseByKey(collection: Collection): { chosen: Map<string, CollectionResource>; unused: CollectionResource[] } {
  const ordered = [...collection.resources].sort((a, b) => {
    const aIn = inPeriod(a.servedTimestamp, collection.period) ? 0 : 1;
    const bIn = inPeriod(b.servedTimestamp, collection.period) ? 0 : 1;
    return (
      aIn - bIn ||
      a.servedTimestamp.localeCompare(b.servedTimestamp) ||
      a.originalUrl.localeCompare(b.originalUrl) ||
      a.sha256.localeCompare(b.sha256)
    );
  });
  const chosen = new Map<string, CollectionResource>();
  const unused: CollectionResource[] = [];
  for (const resource of ordered) {
    const key = siteKey(resource.originalUrl);
    if (chosen.has(key)) unused.push(resource);
    else chosen.set(key, resource);
  }
  return { chosen, unused };
}

export async function buildSiteModel(collection: Collection, readBody: BodyReader = readFromDisk): Promise<SiteModel> {
  const { chosen, unused } = chooseByKey(collection);
  const keys = [...chosen.keys()].sort();
  const siteHosts = [...new Set(keys.map(hostOfKey))].sort();
  const gaps: ModelGap[] = [];

  const parsed: ParsedPage[] = [];
  const assetResources = new Map<string, CollectionResource>();
  for (const key of keys) {
    const resource = chosen.get(key) as CollectionResource;
    const decoded = decodeBody(await readBody(resource), { contentType: resource.contentType });
    if (decoded.kind === 'text' && decoded.text !== null && looksLikeHtml(resource, decoded.text)) {
      const stripped = stripArchiveInjection(decoded.text);
      parsed.push({
        resource,
        key,
        html: stripped.text,
        skeleton: structuralSkeleton(stripped.text),
        chosenEncoding: decoded.chosenEncoding,
        degraded: decoded.degraded,
        removals: stripped.removals.length,
      });
    } else {
      assetResources.set(key, resource);
    }
  }

  const pageIds = new Map(parsed.map((page) => [page.key, idFor(page.key)]));
  const assetIds = new Map([...assetResources.keys()].map((key) => [key, idFor(key)]));

  // Families: each page joins the most similar existing family, or starts one.
  const families: { representative: ParsedPage; members: ParsedPage[] }[] = [];
  for (const page of parsed) {
    let best: { family: (typeof families)[number]; score: number } | null = null;
    for (const family of families) {
      const score = structuralSimilarity(page.skeleton, family.representative.skeleton);
      if (score >= FAMILY_SIMILARITY_THRESHOLD && (best === null || score > best.score)) best = { family, score };
    }
    if (best === null) families.push({ representative: page, members: [page] });
    else best.family.members.push(page);
  }
  const familyIdByKey = new Map<string, string>();
  const modelFamilies: ModelFamily[] = families.map((family, index) => {
    const id = `family-${String(index + 1).padStart(2, '0')}`;
    for (const member of family.members) familyIdByKey.set(member.key, id);
    return {
      id,
      representativePageId: pageIds.get(family.representative.key) as string,
      pageIds: family.members.map((member) => pageIds.get(member.key) as string),
    };
  });

  const occurrences = new Map<string, AssetOccurrence[]>();
  const missing = new Map<string, { kind: ModelGapKind; url: string; referencedBy: Set<string> }>();
  const external = new Map<string, Set<string>>();
  const edges = new Map<string, NavigationEdge>();
  const linkedTo = new Set<string>();

  const pages: ModelPage[] = parsed.map((page) => {
    const id = pageIds.get(page.key) as string;
    const links: ModelLink[] = discoverLinks(page.html, page.resource.originalUrl).map((link) => {
      const key = siteKey(link.resolvedUrl);
      const base = { rawUrl: link.rawUrl, resolvedUrl: link.resolvedUrl, relation: link.relation, location: link.location };
      const pageId = pageIds.get(key);
      if (pageId !== undefined) {
        if (link.relation === 'link' && pageId !== id) {
          edges.set(`${id} ${pageId}`, { from: id, to: pageId });
          linkedTo.add(pageId);
        }
        return { ...base, target: 'page', targetId: pageId };
      }
      const assetId = assetIds.get(key);
      if (assetId !== undefined) {
        const list = occurrences.get(key) ?? [];
        list.push({ pageId: id, location: link.location });
        occurrences.set(key, list);
        return { ...base, target: 'asset', targetId: assetId };
      }
      if (!siteHosts.includes(hostOfKey(key))) {
        const set = external.get(link.resolvedUrl) ?? new Set<string>();
        set.add(id);
        external.set(link.resolvedUrl, set);
        return { ...base, target: 'external', targetId: null };
      }
      const kind = gapKindFor(link.relation);
      const entry = missing.get(`${kind} ${key}`) ?? { kind, url: link.resolvedUrl, referencedBy: new Set<string>() };
      entry.referencedBy.add(id);
      missing.set(`${kind} ${key}`, entry);
      return { ...base, target: 'missing', targetId: null };
    });

    const text = visibleText(page.html);
    if (page.degraded) {
      gaps.push({
        kind: 'degraded-encoding',
        url: page.resource.originalUrl,
        referencedBy: [id],
        detail: `decoded as ${page.chosenEncoding ?? 'unknown'} with replacement characters above the threshold`,
      });
    }
    return {
      id,
      key: page.key,
      originalUrl: page.resource.originalUrl,
      servedTimestamp: page.resource.servedTimestamp,
      sha256: page.resource.sha256,
      provenance: page.resource.provenance,
      title: titleOf(page.html),
      chosenEncoding: page.chosenEncoding,
      textLength: text.length,
      textSha256: hashOf(text),
      familyId: familyIdByKey.get(page.key) as string,
      links,
      features: staticFeatures(page.html),
      archiveInjectionRemovals: page.removals,
    };
  });

  const assets: ModelAsset[] = [...assetResources.entries()].map(([key, resource]) => ({
    id: assetIds.get(key) as string,
    key,
    originalUrl: resource.originalUrl,
    contentType: resource.contentType,
    servedTimestamp: resource.servedTimestamp,
    sha256: resource.sha256,
    byteLength: resource.byteLength,
    provenance: resource.provenance,
    occurrences: occurrences.get(key) ?? [],
  }));

  for (const entry of [...missing.values()].sort((a, b) => a.url.localeCompare(b.url) || a.kind.localeCompare(b.kind))) {
    gaps.push({
      kind: entry.kind,
      url: entry.url,
      referencedBy: [...entry.referencedBy].sort(),
      detail: 'referenced by recovered markup; no body in the collection',
    });
  }
  for (const key of keys) {
    const resource = chosen.get(key) as CollectionResource;
    if (inPeriod(resource.servedTimestamp, collection.period)) continue;
    gaps.push({
      kind: 'date-exception',
      url: resource.originalUrl,
      referencedBy: [],
      detail: `capture ${resource.servedTimestamp} is outside the declared period: ${resource.provenance ?? 'no reason recorded'}`,
    });
  }
  for (const resource of unused) {
    gaps.push({
      kind: 'unused-variant',
      url: resource.originalUrl,
      referencedBy: [],
      detail: `capture ${resource.servedTimestamp} (${resource.sha256.slice(0, 12)}) duplicates a URL the model already holds`,
    });
  }

  return {
    schemaVersion: SITE_MODEL_SCHEMA_VERSION,
    codeRevision: CODE_REVISION,
    collection: {
      id: collection.id,
      source: collection.source,
      period: collection.period,
      resourceCount: collection.resources.length,
      digest: hashOf(keys.map((key) => `${key} ${(chosen.get(key) as CollectionResource).sha256}`).join('\n')),
    },
    siteHosts,
    pages,
    assets,
    families: modelFamilies,
    navigation: {
      edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
      entryPageIds: pages.filter((page) => !linkedTo.has(page.id)).map((page) => page.id),
      external: [...external.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([url, ids]) => ({ url, pageIds: [...ids].sort() })),
    },
    gaps,
  };
}

export async function writeSiteModel(directory: string, model: SiteModel): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, SITE_MODEL_FILE);
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}

export function summarizeSiteModel(model: SiteModel): string {
  const gapCounts = new Map<ModelGapKind, number>();
  for (const gap of model.gaps) gapCounts.set(gap.kind, (gapCounts.get(gap.kind) ?? 0) + 1);
  const pageById = new Map(model.pages.map((page) => [page.id, page]));
  const lines = [
    `site model for ${model.collection.id} (${model.collection.resourceCount} resources, ${model.siteHosts.join(', ')})`,
    `  pages ${model.pages.length}, assets ${model.assets.length}, families ${model.families.length}`,
    `  navigation: ${model.navigation.edges.length} local links, ${model.navigation.external.length} external destinations, ${model.navigation.entryPageIds.length} entry pages`,
  ];
  for (const family of model.families) {
    const representative = pageById.get(family.representativePageId);
    lines.push(`  ${family.id}: ${family.pageIds.length} pages, e.g. ${representative?.originalUrl ?? '?'}`);
  }
  if (gapCounts.size === 0) lines.push('  gaps: none recorded');
  for (const [kind, count] of [...gapCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  gap ${kind}: ${count}`);
  }
  return `${lines.join('\n')}\n`;
}
