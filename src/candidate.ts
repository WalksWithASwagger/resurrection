/**
 * A candidate: a built static site to be judged against a reference bundle.
 *
 *   <candidate>/site/...          the built pages and local assets
 *   <candidate>/url-map.json      which original URL each file stands for
 *
 * The layout is the export's layout, so what is evaluated is what ships. A
 * candidate is served from its own files under a reserved origin. Anything it
 * requests outside that origin is refused and counted against it.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';

import { siteKey } from './collection.ts';
import type { RequestResponder } from './reference.ts';
import { sha256 } from './store.ts';

export const CANDIDATE_ORIGIN = 'http://candidate.invalid';
export const CANDIDATE_SITE_DIRECTORY = 'site';
export const URL_MAP_FILE = 'url-map.json';
export const URL_MAP_SCHEMA_VERSION = 1;

export interface UrlMapEntry {
  originalUrl: string;
  /** POSIX path relative to `site/`. */
  path: string;
}

export interface Candidate {
  directory: string;
  entries: UrlMapEntry[];
  /** Site key of an original URL to its path in the candidate. */
  pathByKey: Map<string, string>;
  /** Path in the candidate to the site key it stands for. */
  keyByPath: Map<string, string>;
  /** SHA-256 over every file under `site/` and the URL map. */
  digest: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', mid: 'audio/midi', swf: 'application/x-shockwave-flash',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return posix.normalize(path) === path && !path.split('/').includes('..');
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function loadCandidate(directory: string): Promise<Candidate> {
  const source = join(directory, URL_MAP_FILE);
  const raw = await readFile(source, 'utf8').catch(() => null);
  if (raw === null) throw new Error(`${source}: a candidate needs a URL map`);
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown; entries?: unknown };
  if (parsed.schemaVersion !== URL_MAP_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error(`${source}: expected schemaVersion ${URL_MAP_SCHEMA_VERSION} and an entries array`);
  }

  const siteRoot = join(directory, CANDIDATE_SITE_DIRECTORY);
  const files = await listFiles(siteRoot);
  const present = new Set(files);
  const entries: UrlMapEntry[] = [];
  const pathByKey = new Map<string, string>();
  const keyByPath = new Map<string, string>();
  for (const value of parsed.entries as unknown[]) {
    const entry = value as Partial<UrlMapEntry>;
    if (typeof entry.originalUrl !== 'string' || typeof entry.path !== 'string' || !isSafeRelativePath(entry.path)) {
      throw new Error(`${source}: every entry needs an originalUrl and a safe relative path`);
    }
    if (!present.has(entry.path)) throw new Error(`${source}: ${entry.path} is mapped but not in ${CANDIDATE_SITE_DIRECTORY}/`);
    const key = siteKey(entry.originalUrl);
    if (pathByKey.has(key)) throw new Error(`${source}: ${entry.originalUrl} is mapped twice`);
    entries.push({ originalUrl: entry.originalUrl, path: entry.path });
    pathByKey.set(key, entry.path);
    if (!keyByPath.has(entry.path)) keyByPath.set(entry.path, key);
  }

  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file} ${sha256(new Uint8Array(await readFile(join(siteRoot, file))))}\n`);
  hash.update(raw);
  return { directory, entries, pathByKey, keyByPath, digest: hash.digest('hex') };
}

/** The path inside `site/` a candidate URL names, or null when it is not a candidate URL. */
export function candidatePathOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== CANDIDATE_ORIGIN) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (path === '' || path.endsWith('/')) path += 'index.html';
  return isSafeRelativePath(path) ? path : null;
}

export function candidateUrlFor(candidate: Candidate, originalUrl: string): string | null {
  const path = candidate.pathByKey.get(siteKey(originalUrl));
  return path === undefined ? null : `${CANDIDATE_ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Serve a candidate from its own files. Everything else is refused, never fetched. */
export function candidateResponder(candidate: Candidate): RequestResponder {
  const siteRoot = resolve(candidate.directory, CANDIDATE_SITE_DIRECTORY);
  return async (url) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { disposition: 'blocked-external' };
    }
    if (origin !== CANDIDATE_ORIGIN) return { disposition: 'blocked-external' };
    const path = candidatePathOf(url);
    if (path === null) return { disposition: 'missing' };
    const absolute = resolve(siteRoot, path);
    if (!absolute.startsWith(siteRoot + sep)) return { disposition: 'missing' };
    const bytes = await readFile(absolute).catch(() => null);
    if (bytes === null) return { disposition: 'missing' };
    const body = new Uint8Array(bytes);
    return { disposition: 'served', body, contentType: contentTypeFor(path), sha256: sha256(body) };
  };
}
